// LLM 通道共用 lib（2026-08-31 片1）。
// 读 opencode.json 主脑绑定（provider/model）+ agent-models.json 取 baseURL/key，
// 发 OpenAI 相容 /chat/completions。key 仅在进程内使用，严禁写入任何返回值/日志/输出。
// 失败一律回 {ok:false, reason}，不降级编造。

const MODELS_PATH = "/opt/eimu-harness/agent-models.json"
const CONFIG_PATH = "/opt/eimu-harness/workspace/.opencode/opencode.json"

interface Channel {
  base: string
  key: string
  model: string
}

let cached: Channel | null = null

async function resolveChannel(): Promise<Channel | null> {
  if (cached) return cached
  try {
    const { readFileSync } = await import("node:fs")
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    const binding = String(cfg?.model || "")
    const slash = binding.indexOf("/")
    if (slash <= 0) return null
    const pid = binding.slice(0, slash)
    const model = binding.slice(slash + 1)
    const reg = JSON.parse(readFileSync(MODELS_PATH, "utf8"))
    const prov = reg?.providers?.[pid]
    const base = String(prov?.options?.baseURL || "").replace(/\/+$/, "")
    const key = String(prov?.options?.apiKey || "")
    if (!base || !key || !model) return null
    cached = { base, key, model }
    return cached
  } catch {
    return null
  }
}

export interface LlmRawResult {
  ok: boolean
  content?: string
  reason?: string
}

/** 一条原始 chat 请求（temperature 0.2，超时 60s）。 */
export async function llmChatRaw(system: string, user: string, maxTokens = 4000): Promise<LlmRawResult> {
  const ch = await resolveChannel()
  if (!ch) return { ok: false, reason: "无法解析 LLM 通道绑定（agent-models.json / opencode.json）" }
  try {
    const res = await fetch(`${ch.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ch.key}` },
      body: JSON.stringify({
        model: ch.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return { ok: false, reason: `LLM 上游 HTTP ${res.status}` }
    const body = (await res.json().catch(() => null)) as Record<string, any> | null
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, reason: "LLM 回覆为空（可能 max_tokens 被推理耗尽）" }
    }
    return { ok: true, content }
  } catch (e) {
    return { ok: false, reason: `LLM 呼叫失败：${(e as Error)?.message || String(e)}` }
  }
}

/** 从 LLM 回覆中抽取 JSON（容忍 markdown 栅栏与前后废话）。 */
export function extractJson(text: string): unknown {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const s = t.indexOf("{")
  const e = t.lastIndexOf("}")
  if (s < 0 || e <= s) return null
  try {
    return JSON.parse(t.slice(s, e + 1))
  } catch {
    return null
  }
}

/** 要求 LLM 输出 JSON 物件；解析失败回 ok:false + 诚实 reason。 */
export async function llmChatJson(
  system: string,
  user: string,
  maxTokens = 4000,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  const r = await llmChatRaw(system, user, maxTokens)
  if (!r.ok) return { ok: false, reason: r.reason || "LLM 失败" }
  const parsed = extractJson(r.content || "")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `LLM 回覆无法解析为 JSON 物件：${(r.content || "").slice(0, 200)}` }
  }
  return { ok: true, data: parsed as Record<string, unknown> }
}
