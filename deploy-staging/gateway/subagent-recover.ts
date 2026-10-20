import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { bindGenerationConsumer, saveDurableSubagentRun, durableSubagentRun, durableSubagentRuns } from "./job-store"
import { loadReworkRecords, ReworkRecord } from "./persistence"
import type { SubagentRun, ChildProbe } from "./subagent-types.ts"
import { SUBAGENT_OUTPUT_REL, SUBAGENT_OUTPUT_DIR, isOpenCodeSessionId, textBlocksOfMessage } from "./subagent-types.ts"
import { deps, byParent, byChildOc, completed } from "./subagent-runs.ts"
import { finishRun } from "./subagent-finish.ts"
import { summarizeChild } from "./subagent-liveness.ts"
import { subagentChildSlug, ensureTranscript } from "./subagent-live.ts"

/** 刀1：扫 outputs/subagent/<runId前8码>-*.md，取最新一笔（同前缀理论唯一，兜底取 mtime 最大）。 */
export function findPersistedArtifact(subagentId: string): { relPath: string; bytes: number; mtimeMs: number; status: string; label: string } | null {
  const prefix = subagentId.replace(/-/g, "").slice(0, 8)
  if (!/^[0-9a-f]{8}$/i.test(prefix)) return null
  try {
    const hits = readdirSync(SUBAGENT_OUTPUT_DIR)
      .filter((f) => f.startsWith(prefix))
      .map((f) => {
        const abs = join(SUBAGENT_OUTPUT_DIR, f)
        const st = statSync(abs)
        // 档头 meta 行是机器写的（persistRunOutput），status/label 直接抽，不读全文。
        const head = readFileSync(abs, "utf8").slice(0, 400)
        const status = /^- 状态: (.+)$/m.exec(head)?.[1]?.trim() ?? "unknown"
        const label = /^# (.+)$/m.exec(head)?.[1]?.trim() ?? ""
        return { relPath: `${SUBAGENT_OUTPUT_REL}/${f}`, bytes: st.size, mtimeMs: st.mtimeMs, status, label }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return hits[0] ?? null
  } catch {
    return null // 目录不可读/不存在 → 维持原 404 行为（fail-open）
  }
}

// ── 刀 F（2026-09-15）：rework 链重启存活——启动扫描治理 in-flight rework 孤儿 ──────────
// 病灶：rework 在途时 gateway 被重启（round3 13:03:37），SubagentRun/watchers 纯记忆体随旧
// 进程死亡 → 子 opencode 会话孤儿 RUNNING（算力白烧）、父会话永挂无 done/无 wake。
// 治法：startRework 落一条 subagent_reworks 记录（child_oc 探针目标），finishRun 终态删。
// 启动时扫残留记录，探 opencode 子会话真况：
//   · 已完成 → 拉正文重跑闸门复检，走既有 finishRun 正常链 done/wake（单终态守卫复用）。
//   · 仍 RUNNING 且 watcher 死 → **不幽灵续 watch**，按诚实路径：finishRun(orphaned) 内部
//     abort+DELETE 子会话 + done delivery_gate.orphaned + 带前缀 wake 父会话一次。
// 幂等：记录终态即删，残留=真孤儿；wake 单次由 finishRun status 守卫 + wakeParent ackTimer
// 让位保证，与正常链不双 wake。

function runFromReworkRecord(rec: ReworkRecord): SubagentRun {
  return {
    id: rec.runId,
    parentGatewaySessionId: rec.parentGw,
    parentOpencodeSessionId: rec.parentOc,
    opencodeSessionId: rec.childOc,
    label: rec.label,
    startedAt: rec.updatedAt,
    status: "running",
    prompt: "",
    modelChain: [],
    attempt: 1,
    messageRole: new Map(),
    partEmitted: new Map(),
    partKind: new Map(),
    suppressedParts: new Set(),
    partText: new Map(),
    beastMode: rec.beast,
    agent: rec.agent || undefined,
    asyncMode: rec.asyncMode,
    reworkCount: rec.reworkCount || 1,
    // 2026-10-14 协作总线：启动重建的孤儿 run 同样要有总线字段（它是 finishRun(orphaned)
    // 的输入，缺栏会在收尾路径上炸 undefined）。
    childPath: `/root/${subagentChildSlug(rec.label, rec.runId)}`,
    toolTimeline: [],
    pendingChildMessages: [],
    pendingParentNotes: [],
    pendingQuestions: [],
    submissionSeq: 0,
    lastActivityAt: Date.now(),
    pendingTools: new Set(),
    artifacts: [],
    toolStatusEmitted: new Map(),
    // SubagentRun 的必填栏位：残留 rework 重建时从零个检查点开始。
    checkpoints: [],
  }
}

/** 探 opencode 子会话：HTTP 非 ok/404 → 不存在；取最后一条 assistant 的 completed 判终态、
 *  其 text parts 作正文。time.completed===null = turn 仍 RUNNING（对齐验尸配方）。 */
async function probeChildSession(childOc: string): Promise<ChildProbe> {
  if (!deps || !isOpenCodeSessionId(childOc)) return { exists: false, completed: false, text: "" }
  try {
    const res = await fetch(`${deps.openCodeUrl}/session/${childOc}/message`, {
      headers: deps.openCodeHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { exists: false, completed: false, text: "" }
    const msgs = (await res.json()) as Array<{
      info?: { role?: string; error?: unknown; time?: { completed?: number | null } }
      parts?: Array<{ type?: string; text?: string; state?: { status?: string } }>
    }>
    if (!Array.isArray(msgs) || msgs.length === 0) return { exists: true, completed: false, text: "" }
    const latestUserIndex = msgs.findLastIndex((m) => m?.info?.role === "user")
    const currentTurn = msgs.slice(Math.max(0, latestUserIndex))
    const lastAssistant = [...currentTurn].reverse().find((m) => m?.info?.role === "assistant")
    if (!lastAssistant) return { exists: true, completed: false, text: "" }
    const completed = lastAssistant.info?.time?.completed != null
    const text = (lastAssistant.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("\n")
      .trim()
    const pendingToolCount = (lastAssistant.parts || []).filter((part) => part.type === "tool" && ["pending", "running"].includes(part.state?.status || "")).length
    const error = lastAssistant.info?.error ? deps.describeError(lastAssistant.info.error) : undefined
    return { exists: true, completed, text, error, pendingToolCount }
  } catch {
    // 探测失败（opencode 短暂不可达）保守回 exists:false，让本轮先不处理——但呼叫端
    // 对 !exists 走孤儿诚实收尾。为避免 opencode 抖动误杀，仅在明确 HTTP 非 ok 才标 !exists；
    // 网络异常在此回 exists:true/completed:false（视为仍 RUNNING），下一轮重启再评。
    return { exists: true, completed: false, text: "" }
  }
}

/** gateway 启动一次性调用：治理 rework 孤儿（见上方注解块）。 */
function reviveSavedRun(saved: any): SubagentRun {
  const decoded = JSON.parse(JSON.stringify(saved), (_key, value) => value?.__map ? new Map(value.__map) : value?.__set ? new Set(value.__set) : value)
  const run = { ...decoded, status: "running", recoveredWatcher: true, reworking: false, modelChain: [], reworkCount: Math.max(1, decoded.reworkCount || 0), lastActivityAt: Date.now() } as SubagentRun
  for (const key of ["messageRole", "partEmitted", "partKind", "partText", "toolStatusEmitted"]) if (!((run as any)[key] instanceof Map)) (run as any)[key] = new Map()
  for (const key of ["suppressedParts", "pendingTools"]) if (!((run as any)[key] instanceof Set)) (run as any)[key] = new Set()
  if (!(run.pendingToolSince instanceof Map)) run.pendingToolSince = new Map()
  if (!(run.pendingToolInfo instanceof Map)) run.pendingToolInfo = new Map()
  run.artifacts ||= []
  return run
}
function seedTakenOverCursor(run: SubagentRun, messages: any[]): void {
  for (const message of messages) {
    const info = message.info || {}
    if (info.id && info.role) run.messageRole.set(info.id, info.role)
    if (info.role !== "assistant") continue
    for (const part of message.parts || []) {
      if ((part.type === "text" || part.type === "reasoning") && part.id && typeof part.text === "string") {
        run.partKind.set(part.id, part.type)
        run.partText.set(part.id, part.text)
        run.partEmitted.set(part.id, part.text.length)
      }
      if (part.type === "tool" && part.callID) {
        const st = part.state?.status
        if (["pending", "running"].includes(st)) {
          run.pendingTools.add(part.callID)
          // 2026-10-19：重建时补上工具起始时刻，否则「命令永远 running」的重建 run 没有
          // 任何时长依据，工具硬线永远不触发（实测就是永久「终端命令 运行中」）。
          const started = Number(part.state?.time?.start) || Date.now()
          if (!run.pendingToolSince) run.pendingToolSince = new Map()
          if (!run.pendingToolSince.has(part.callID)) run.pendingToolSince.set(part.callID, started)
          if (!run.pendingToolInfo) run.pendingToolInfo = new Map()
          const out = typeof part.state?.metadata?.output === "string" ? part.state.metadata.output : ""
          run.pendingToolInfo.set(part.callID, {
            name: typeof part.tool === "string" ? part.tool : "",
            outLen: out.length,
            outAt: out.length > 0 ? Math.max(started, Number(part.state?.time?.end) || 0) : 0,
          })
        } else {
          run.pendingTools.delete(part.callID)
          run.pendingToolSince?.delete(part.callID)
          run.pendingToolInfo?.delete(part.callID)
        }
        run.toolStatusEmitted.set(part.callID, ["pending", "running"].includes(st) ? "running" : st === "completed" ? "ok" : "failed")
      }
    }
  }
}
let takeoverReconciling = false
let takeoverBackoffUntil = 0
let takeoverFailStreak = 0
async function reconcileTakenOverRuns(): Promise<void> {
  if (!deps || takeoverReconciling) return
  if (Date.now() < takeoverBackoffUntil) return
  // 无 recoveredWatcher 在跑时不打 /session/status——opencode 内存顶满时每 15s 一次 10s 超时会与真实派工抢通道（2026-10-17 实锤）。
  let hasWatcher = false
  for (const run of byChildOc.values()) {
    if (run.recoveredWatcher && run.status === "running") { hasWatcher = true; break }
  }
  if (!hasWatcher) return
  takeoverReconciling = true
  try {
    const response = await fetch(`${deps.openCodeUrl}/session/status`, { headers: deps.openCodeHeaders(), signal: AbortSignal.timeout(5000) })
    if (!response.ok) return
    const statuses: any = await response.json()
    for (const run of byChildOc.values()) {
      if (!run.recoveredWatcher || run.status !== "running") continue
      if (statuses[run.opencodeSessionId]?.type && statuses[run.opencodeSessionId].type !== "idle") continue
      const probe = await probeChildSession(run.opencodeSessionId)
      // HTTP errors or absent child are unknown, never permission to abort/recreate.
      if (probe.exists && probe.completed && !probe.pendingToolCount) {
        if (probe.error) await finishRun(run, "error", probe.text, probe.error)
        else await summarizeChild(run)
      }
    }
    takeoverFailStreak = 0
  } catch (error) {
    takeoverFailStreak++
    const delay = Math.min(300_000, 15_000 * (2 ** Math.min(takeoverFailStreak, 4)))
    takeoverBackoffUntil = Date.now() + delay
    console.warn(`[gateway] takeover reconciliation deferred: ${error instanceof Error ? error.message : "unavailable"} (backoff ${Math.round(delay / 1000)}s streak=${takeoverFailStreak})`)
  } finally { takeoverReconciling = false }
}
/** Reattach the original OpenCode stream; never POST prompt, generate, abort or DELETE on takeover. */
export async function recoverReworkRunsOnStartup(): Promise<void> {
  if (!deps) return
  const source = process.env.SUBAGENT_RECOVERY_MANIFEST || "/opt/agent-harness/state/subagent-recovery.json"
  try {
    const records = JSON.parse(readFileSync(source, "utf8"))
    if (Array.isArray(records)) for (const record of records) {
      try {
      if (durableSubagentRun(record.runId)) continue
      const evidence = /subagent dispatched: id=(\S+) label="(.*?)" parent=(\S+) child=(\S+)(?: mode=(\S+))?/.exec(record.journalEvidence || "")
      if (!evidence || evidence[1] !== record.runId || evidence[3] !== record.parentGw || evidence[4] !== record.childOc) throw new Error("legacy takeover ownership evidence mismatch")
      const parent = deps.resolveSession(record.parentGw)
      if (!parent) continue
      const response = await fetch(`${deps.openCodeUrl}/session/${record.childOc}/message`, { headers: deps.openCodeHeaders(), signal: AbortSignal.timeout(10000) })
      if (!response.ok) continue
      const messages = (await response.json()) as any[]
      const firstUser = messages.find((m) => m.info?.role === "user")
      if (!firstUser) continue
      const agent = [...messages].reverse().find((m) => m.info?.role === "assistant")?.info?.agent
      const run = runFromReworkRecord({ runId: record.runId, parentGw: record.parentGw, parentOc: parent.opencodeSessionId, childOc: record.childOc, label: evidence[2], agent: agent || "", beast: false, asyncMode: evidence[5] === "async", reworkCount: 1 } as any)
      if (!Number.isFinite(firstUser.info?.time?.created) || firstUser.info.time.created <= 0) continue
      run.startedAt = firstUser.info.time.created
      run.prompt = textBlocksOfMessage(firstUser)
      run.recoveredWatcher = true
      seedTakenOverCursor(run, messages)
      ensureTranscript(run)
      bindGenerationConsumer(run.opencodeSessionId, run.parentGatewaySessionId, run.parentOpencodeSessionId, run.agent)
      saveDurableSubagentRun(run)
      } catch (error) { console.warn("[gateway] individual legacy takeover deferred:", record.runId, error instanceof Error ? error.message : "unavailable") }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") console.error("[gateway] legacy takeover manifest deferred:", error instanceof Error ? error.message : "unavailable")
  }
  // Existing durable rework records also transfer to watchers rather than abort+DELETE.
  for (const record of loadReworkRecords()) if (!durableSubagentRun(record.runId)) {
    const run = runFromReworkRecord(record)
    ensureTranscript(run)
    bindGenerationConsumer(run.opencodeSessionId, run.parentGatewaySessionId, run.parentOpencodeSessionId, run.agent)
    saveDurableSubagentRun(run)
  }
  for (const saved of durableSubagentRuns()) {
    if (saved.result) { completed.set(saved.id, saved.result); continue }
    if (!isOpenCodeSessionId(saved.opencodeSessionId)) continue
    const run = reviveSavedRun(saved)
    try {
      const response = await fetch(`${deps.openCodeUrl}/session/${run.opencodeSessionId}/message`, { headers: deps.openCodeHeaders(), signal: AbortSignal.timeout(10000) })
      if (response.ok) seedTakenOverCursor(run, await response.json() as any[])
    } catch { /* Existing cursor stays durable while canonical source is temporarily unavailable. */ }
    byChildOc.set(run.opencodeSessionId, run)
    const list = byParent.get(run.parentGatewaySessionId) || []
    if (!list.some((existing) => existing.id === run.id)) list.push(run)
    byParent.set(run.parentGatewaySessionId, list)
    ensureTranscript(run)
    bindGenerationConsumer(run.opencodeSessionId, run.parentGatewaySessionId, run.parentOpencodeSessionId, run.agent)
  }
  await reconcileTakenOverRuns()
  // 有 watcher 才真正打 opencode；失败时 reconcileTakenOverRuns 内指数退避，避免 15s 风暴。
  setInterval(() => void reconcileTakenOverRuns(), 15000).unref?.()
}

