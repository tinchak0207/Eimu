import { opencodeFetch } from "./opencode-client"
import { loadSessionByOpencodeId } from "./persistence"
import { hashKey } from "./auth-gw"
import { MEMORY_INGEST_SECRET, MEMORY_INGEST_BASE_URL } from "./constants-gateway"
import { MEMORY_SIGNATURE_HEADER, signMemoryBytes, type MemorySessionRecord } from "./memory-batch"
import { bindingRef } from "./model-registry"
// ── 批次接线（契约 §3.5/§8；轮子表 §10）──────────────────────────────────

// PRD §5.2 条件③：知识型（外部信息摄入）工具集，排序加权用。
export const KNOWLEDGE_TOOL_NAMES = new Set(["search_web", "search_aggregate", "smart_search", "vision_analyze", "asset_search", "image_get_result"])

/** transcriptOf：复用 handleTranscript 的 fetch 形状（opencode GET /session/:id/message），渲染成纯文本。 */
export async function memoryTranscriptOf(opencodeSessionId: string): Promise<string> {
  const res = await opencodeFetch(`/session/${encodeURIComponent(opencodeSessionId)}/message`, {
    timeoutMs: 10_000,
  })
  if (!res.ok) throw new Error(`memory transcript fetch HTTP ${res.status}`)
  const msgs = (await res.json()) as Array<Record<string, any>>
  const lines: string[] = []
  for (const m of Array.isArray(msgs) ? msgs.slice(-200) : []) {
    const role = m?.info?.role === "user" ? "user" : "assistant"
    for (const p of Array.isArray(m?.parts) ? m.parts : []) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
        lines.push(`${role}: ${p.text.trim()}`)
      } else if (p?.type === "tool" && typeof p.tool === "string") {
        const status = typeof p?.state?.status === "string" ? p.state.status : "unknown"
        lines.push(`${role} [tool ${p.tool} ${status}]`)
      }
    }
  }
  const transcript = lines.join("\n")
  // 上限比照轮子 100k 量级再收敛（curator 输入面）；超长取尾——最近回合最有价值。
  return transcript.length > 60_000 ? transcript.slice(-60_000) : transcript
}

/** 逐会话讯息计数（PRD §5.2 条件②③）。失败＝计不出 → 全 0，筛选自然放弃。 */
export async function memorySessionCounts(
  opencodeSessionId: string,
): Promise<{ userMessages: number; successfulToolCalls: number; knowledgeToolCalls: number }> {
  let userMessages = 0
  let successfulToolCalls = 0
  let knowledgeToolCalls = 0
  try {
    const res = await opencodeFetch(`/session/${encodeURIComponent(opencodeSessionId)}/message`, {
      timeoutMs: 10_000,
    })
    if (!res.ok) return { userMessages: 0, successfulToolCalls: 0, knowledgeToolCalls: 0 }
    const msgs = (await res.json()) as Array<Record<string, any>>
    for (const m of Array.isArray(msgs) ? msgs : []) {
      if (m?.info?.role === "user") userMessages += 1
      for (const p of Array.isArray(m?.parts) ? m.parts : []) {
        if (p?.type === "tool" && p?.state?.status === "completed") {
          successfulToolCalls += 1
          if (KNOWLEDGE_TOOL_NAMES.has(String(p.tool ?? ""))) knowledgeToolCalls += 1
        }
      }
    }
  } catch {
    return { userMessages: 0, successfulToolCalls: 0, knowledgeToolCalls: 0 }
  }
  return { userMessages, successfulToolCalls, knowledgeToolCalls }
}

/** listSessions：loopback GET /session（opencode 目录）＋ sessions.db 反查 ownerKey（hashKey 同算法）。 */
export async function memoryListSessions(): Promise<MemorySessionRecord[]> {
  const res = await opencodeFetch(`/session`, {
    timeoutMs: 10_000,
  })
  if (!res.ok) throw new Error(`memory listSessions HTTP ${res.status}`)
  const dir = (await res.json()) as Array<Record<string, any>>
  const nowMs = Date.now()
  const out: MemorySessionRecord[] = []
  const needCounts: MemorySessionRecord[] = []
  for (const s of Array.isArray(dir) ? dir : []) {
    const id = typeof s?.id === "string" ? s.id : ""
    if (!id) continue
    const parentId = typeof s?.parentID === "string" && s.parentID ? s.parentID : null
    const time = s?.time as { created?: number; updated?: number } | undefined
    const updatedAt =
      typeof time?.updated === "number" ? time.updated : typeof time?.created === "number" ? time.created : undefined
    const rec: MemorySessionRecord = { id, parentId, updatedAt }
    try {
      const row = loadSessionByOpencodeId(id) // 只读 DB row，不走 findSessionByOpenCodeId（那会把会话僵尸复活进内存）
      if (row?.apiKey) rec.ownerKey = await hashKey(row.apiKey)
    } catch {
      /* ownerKey 缺失 → private 无处安放（批次按 g4_no_owner 记帐） */
    }
    // 计数只补非 subagent 且 48 小时内（UTC）有动的会话：批次条件②的门槛筛选需要计数，
    // 更旧的计数缺也过不了门槛——避免全目录逐会话 message GET（R5 尺：批次窗口不挤压主对话）。
    // 手动指定 session_ids 重跑不依赖计数（批次在该路径不看门槛）。
    if (!parentId && typeof updatedAt === "number" && nowMs - updatedAt <= 48 * 3600_000) {
      needCounts.push(rec)
    }
    out.push(rec)
  }
  // 并发上限 4：背景计算，让主链路先走。
  for (let i = 0; i < needCounts.length; i += 4) {
    const chunk = needCounts.slice(i, i + 4)
    const counts = await Promise.all(chunk.map((r) => memorySessionCounts(r.id)))
    chunk.forEach((r, j) => {
      r.userMessages = counts[j].userMessages
      r.successfulToolCalls = counts[j].successfulToolCalls
      r.knowledgeToolCalls = counts[j].knowledgeToolCalls
    })
  }
  return out
}

/** callLlm = handleExtractLessons 三段骨架逐行复制（契约 §10 轮子表）。白名单：prompt 直传、超时 120s→180s、函式名／回传纯文本；模型与通道同轮子常量（不带 model 栏，opencode 默认路由）。 */
export async function memoryCallLlm(prompt: string): Promise<string> {
  // 一次性 opencode session（与对话 pool 无关），同步取结果后即删。
  let session: { id?: string }
  try {
    const res = await opencodeFetch(`/session`, {
      method: "POST",
      body: "{}",
      timeoutMs: 10000,
    })
    if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
    session = (await res.json()) as { id?: string }
  } catch {
    throw new Error("opencode backend unreachable")
  }
  if (!session.id) throw new Error("opencode did not return a session id")
  const opencodeSessionId = session.id
  try {
    const res = await opencodeFetch(`/session/${opencodeSessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
      timeoutMs: 180000, // 白名单改动：curator 全文输入，窗口放宽到 180s
    })
    if (!res.ok) throw new Error(`opencode curator call failed: ${res.status}`)
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    return texts.length > 0 ? texts[texts.length - 1] : ""
  } finally {
    await opencodeFetch(`/session/${opencodeSessionId}`, {
      method: "DELETE",
      timeoutMs: 10000,
    }).catch(() => {})
  }
}

/** ingest/review 送出（§3.1/§3.2＋P1-1 review 端点，同一 HMAC 签名通道）。headers 由 memory-batch 按「将送出的精确 raw bytes」算好签名传入，这里防卫性重签同一串（同算法同值）；非 2xx throw（批次落 pending 指数退避）。 */
export async function memoryPostIngest(
  pathOnly: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  if (!MEMORY_INGEST_SECRET) throw new Error("MEMORY_INGEST_SECRET 未配置")
  const res = await fetch(`${MEMORY_INGEST_BASE_URL}${pathOnly}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
      [MEMORY_SIGNATURE_HEADER]: signMemoryBytes(rawBody, MEMORY_INGEST_SECRET),
    },
    body: rawBody, // 原样位元组串，严禁重新序列化（签名即失效）
    signal: AbortSignal.timeout(30_000),
  })
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON 回应 → null；成败以 status 为准 */
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`memory ingest HTTP ${res.status}`)
  return { status: res.status, json }
}

/**
 * verifier/oracle 一次性 LLM 呼叫＝memoryCallLlm 三段骨架逐行复制（契约 §10 轮子表）。
 * 白名单改动：① 签名加 model 参数（G8/抽检「换模型」）；② message body 附
 * `model: {providerID, modelID}`（既有轮走 opencode 默认路由，此轮必须指定另一模型），
 * 字串以 bindingRef 解析 `provider/model`，解析不了即 throw（fail-fast 诚实报错）；
 * ③ 错误讯息以 label 区分。通道与超时同轮子（建/删 10s、呼叫 180s）。
 */
export async function memoryCallLlmWithModel(prompt: string, model: string, label: string): Promise<string> {
  const ref = bindingRef(model)
  if (!ref) throw new Error(`memory ${label}: invalid model ref (expect provider/model)`)
  // 一次性 opencode session（与对话 pool 无关），同步取结果后即删。
  let session: { id?: string }
  try {
    const res = await opencodeFetch(`/session`, {
      method: "POST",
      body: "{}",
      timeoutMs: 10000,
    })
    if (!res.ok) throw new Error(`opencode create session failed: ${res.status}`)
    session = (await res.json()) as { id?: string }
  } catch {
    throw new Error("opencode backend unreachable")
  }
  if (!session.id) throw new Error("opencode did not return a session id")
  const opencodeSessionId = session.id
  try {
    const res = await opencodeFetch(`/session/${opencodeSessionId}/message`, {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
        model: { providerID: ref.providerID, modelID: ref.modelID },
      }),
      timeoutMs: 180000, // 白名单改动：curator 全文输入，窗口放宽到 180s
    })
    if (!res.ok) throw new Error(`opencode ${label} call failed: ${res.status}`)
    const payload = (await res.json()) as { parts?: Array<{ type?: string; text?: string }> }
    const texts = (payload.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
    return texts.length > 0 ? texts[texts.length - 1] : ""
  } finally {
    await opencodeFetch(`/session/${opencodeSessionId}`, {
      method: "DELETE",
      timeoutMs: 10000,
    }).catch(() => {})
  }
}
