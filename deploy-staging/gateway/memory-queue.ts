/**
 * memory-queue.ts — 「该写记忆」待提炼队列与审计（2026-10-19）。
 *
 * 设计边界（与工单一致）：
 *   - 只入队：收盘路径不呼叫 LLM、不自动跑批次；批次激活仍由既有
 *     `MEMORY_BATCH_ENABLED` 与人工/定时决定。
 *   - 队列目录：`MEMORY_QUEUE_DIR`（默认 `/opt/eimu-harness/state/memory-queue`）；
 *     不可写时回退 `./.memory-queue`（本地开发）。
 *   - 同 session 合并：kinds 去重合并、attempts+1、updatedAt 更新；原子写（tmp + rename）。
 *   - 审计：`<queueDir>/memory-audit.jsonl`，只记事件元资料（不写 sample/正文）。
 *   - 所有 IO 失败只 `console.warn` 代号，**永不 throw**——收盘路径不能被记忆拖死。
 */
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile, access } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { join, resolve } from "node:path"
import { sanitizeMemorySample, type MemorySignalKind } from "./memory-trigger.ts"

export const DEFAULT_MEMORY_QUEUE_DIR = "/opt/eimu-harness/state/memory-queue"
export const MEMORY_AUDIT_FILENAME = "memory-audit.jsonl"

export interface MemoryQueueRecord {
  sessionId: string
  ownerKey?: string
  kinds: MemorySignalKind[]
  sample: string
  attempts: number
  updatedAt: string
}

export interface EnqueueMemorySignalInput {
  sessionId: string
  ownerKey?: string
  kinds: MemorySignalKind[]
  sample: string
  /** 测试注入用；生产省略＝Date.now()。 */
  nowMs?: number
}

export interface MemoryAuditEvent {
  event: "enqueue" | "stored" | "no_docs" | "drained" | "dropped_after_attempts"
  sessionId: string
  kinds?: MemorySignalKind[]
  stored?: number
}

/** 无产出重试上限：连续次批次仍提炼不出候选 → 移入 `failed/`，不无限重试。 */
export const SIGNAL_MAX_ATTEMPTS = 5
export const SIGNAL_FAILED_DIRNAME = "failed"

export interface SignalNoDocsResult {
  /** 递增后的 attempts（档不存在时为 0）。 */
  attempts: number
  /** true＝已达上限并已原子移入 `failed/`。 */
  dropped: boolean
}

/** 队列文件名的安全化：去掉路径分隔符／控制字元，避免逃逸目录。 */
export function safeSessionId(sessionId: string): string {
  const raw = typeof sessionId === "string" ? sessionId : ""
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 120)
  return cleaned || "_"
}

function warn(code: string): void {
  // 只留代号，不带路径细节以外的内容；不含正文。
  console.warn(`[gateway] memory-queue: ${code}`)
}

async function dirWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    await access(dir, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 解析队列目录（env → 默认 → 本地回退）。
 * 每次呼叫都重新解析：不缓存 env，便于本地工具/测试切换目录。
 */
export async function resolveMemoryQueueDir(): Promise<string> {
  const configured = String(process.env.MEMORY_QUEUE_DIR ?? "").trim()
  const primary = configured || DEFAULT_MEMORY_QUEUE_DIR
  if (await dirWritable(primary)) return primary
  const fallback = resolve(process.cwd(), ".memory-queue")
  if (fallback !== primary && (await dirWritable(fallback))) return fallback
  warn("queue_dir_unwritable")
  return fallback
}

function queueFilePath(dir: string, sessionId: string): string {
  return join(dir, `${safeSessionId(sessionId)}.json`)
}

function normalizeRecord(value: unknown, fallbackSessionId: string): MemoryQueueRecord | null {
  if (!value || typeof value !== "object") return null
  const o = value as Record<string, unknown>
  const kindsRaw = Array.isArray(o.kinds) ? o.kinds : []
  const allowed: MemorySignalKind[] = ["user_correction", "tool_failure", "repeated_failure"]
  const kinds = allowed.filter((k) => kindsRaw.includes(k))
  const sessionId = typeof o.sessionId === "string" && o.sessionId ? o.sessionId : fallbackSessionId
  const attempts = typeof o.attempts === "number" && Number.isFinite(o.attempts) ? Math.max(0, Math.floor(o.attempts)) : 0
  const sample = typeof o.sample === "string" ? o.sample : ""
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : new Date(0).toISOString()
  const rec: MemoryQueueRecord = { sessionId, kinds, sample, attempts, updatedAt }
  if (typeof o.ownerKey === "string" && o.ownerKey) rec.ownerKey = o.ownerKey
  return rec
}

/**
 * 入队（同 session 合并）。失败只 warn，不抛；回传是否真的落盘
 * （true＝rename 成功，可据此写 enqueue 审计，避免审计虚增信号会话）。
 * 原子写：同目录 `<file>.<pid>.<rand>.tmp` → rename，读者永远看不到半截 JSON。
 *
 * 2026-10-19 P2-4：
 *   - sample 在入队层再脱敏一次并硬截（不依赖调用方）；
 *   - 同 session 并发入队走模组级串行链，保证 read-modify-write 不丢 attempts/kinds。
 */
export async function enqueueMemorySignal(input: EnqueueMemorySignalInput): Promise<boolean> {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : ""
  if (!sessionId) {
    warn("enqueue_missing_session")
    return false
  }
  return withSessionEnqueueLock(sessionId, async () => {
    try {
      const dir = await resolveMemoryQueueDir()
      const file = queueFilePath(dir, sessionId)
      const nowMs = typeof input.nowMs === "number" && Number.isFinite(input.nowMs) ? input.nowMs : Date.now()

      let existing: MemoryQueueRecord | null = null
      try {
        existing = normalizeRecord(JSON.parse(await readFile(file, "utf8")), sessionId)
      } catch {
        // 不存在或坏档：按首次入队处理（坏档会被原子写覆盖）。
        existing = null
      }

      const kinds: MemorySignalKind[] = []
      for (const k of [...(existing?.kinds ?? []), ...(Array.isArray(input.kinds) ? input.kinds : [])]) {
        if (!kinds.includes(k)) kinds.push(k)
      }
      // 入队层自保：无论调用方是否脱敏，这里再走同一函式并硬截 120 字元。
      const incomingSample = sanitizeMemorySample(typeof input.sample === "string" ? input.sample : "").slice(0, 120)
      const record: MemoryQueueRecord = {
        sessionId,
        kinds,
        sample: incomingSample || existing?.sample || "",
        attempts: (existing?.attempts ?? 0) + 1,
        updatedAt: new Date(nowMs).toISOString(),
      }
      const ownerKey = input.ownerKey || existing?.ownerKey
      if (ownerKey) record.ownerKey = ownerKey

      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
      try {
        await writeFile(tmp, `${JSON.stringify(record)}\n`, "utf8")
        await rename(tmp, file)
      } catch (e) {
        warn("enqueue_write_failed")
        // 尽力清掉可能残留的 tmp（失败也不抛）。
        await unlink(tmp).catch(() => undefined)
        throw e
      }
      return true
    } catch {
      // 已 warn；此处兜底吞掉，保证收盘路径不因记忆 IO 失败而中断。
      return false
    }
  })
}

// ── 同 session 入队串行化（进程内互斥）──────────────────────────────────
// 两个并发 enqueue 会同时读到旧 attempts/kinds，后写者覆盖先写者（丢更新）。
// 以 Promise 链把同 session 的 read-modify-write 串起来：不同 session 互不阻塞，
// 链排空后清理 Map 条目（无界增长防护）。
const enqueueChains = new Map<string, Promise<void>>()

async function withSessionEnqueueLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = enqueueChains.get(sessionId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate
  })
  const tail = prev.then(() => gate)
  enqueueChains.set(sessionId, tail)
  // prev 只会在 gate resolve 后完成，不会 reject；防御性 await 兜住异常链。
  await prev.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    // 只有自己仍是链尾时才清理；后续排队者会把 Map 指向更晚的 tail。
    if (enqueueChains.get(sessionId) === tail) enqueueChains.delete(sessionId)
  }
}

/** 列出待提炼信号（按 updatedAt 升序，最早失败优先处理）。失败返回空阵列。 */
export async function listPendingSignals(): Promise<MemoryQueueRecord[]> {
  try {
    const dir = await resolveMemoryQueueDir()
    const names = await readdir(dir)
    const out: MemoryQueueRecord[] = []
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".tmp.json")) continue
      const file = join(dir, name)
      try {
        const rec = normalizeRecord(JSON.parse(await readFile(file, "utf8")), name.slice(0, -".json".length))
        if (rec) out.push(rec)
      } catch {
        warn("list_read_failed")
      }
    }
    out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    return out
  } catch {
    warn("list_dir_failed")
    return []
  }
}

/**
 * 标记已处理：删除队列档。失败（含不存在）不抛。
 * 回传 true＝队列档已不存在（本呼叫删除或原本就不在，幂等视作已消费）；
 * false＝删除失败（档仍在，下批会再消费一次）。
 */
export async function markSignalDone(sessionId: string): Promise<boolean> {
  try {
    const dir = await resolveMemoryQueueDir()
    await unlink(queueFilePath(dir, sessionId))
    return true
  } catch (e) {
    // ENOENT 是正常幂等路径（别处已消费）；其余只 warn 代号。
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return true
    warn("mark_done_failed")
    return false
  }
}

/**
 * 本批处理过但**零候选产出**：attempts+1，保留队列等下批再提炼；
 * 递增后 ≥ SIGNAL_MAX_ATTEMPTS → 原子 rename 进 `<queueDir>/failed/`（不再重试）。
 *
 * 与 enqueue 共用同 session 串行链，避免 read-modify-write 丢更新。
 * 所有 IO 失败只 warn、不 throw；回传 dropped 只在 rename 真的成功后为 true。
 */
export async function recordSignalNoDocs(sessionId: string): Promise<SignalNoDocsResult> {
  const id = typeof sessionId === "string" ? sessionId : ""
  if (!id) {
    warn("signal_no_docs_missing_session")
    return { attempts: 0, dropped: false }
  }
  return withSessionEnqueueLock(id, async () => {
    try {
      const dir = await resolveMemoryQueueDir()
      const file = queueFilePath(dir, id)
      let rec: MemoryQueueRecord | null = null
      try {
        rec = normalizeRecord(JSON.parse(await readFile(file, "utf8")), id)
      } catch {
        rec = null
      }
      if (!rec) return { attempts: 0, dropped: false }
      const attempts = rec.attempts + 1
      if (attempts >= SIGNAL_MAX_ATTEMPTS) {
        const failedDir = join(dir, SIGNAL_FAILED_DIRNAME)
        try {
          await mkdir(failedDir, { recursive: true })
          await rename(file, join(failedDir, `${safeSessionId(id)}.json`))
          return { attempts, dropped: true }
        } catch {
          // 搬移失败：档保持原地（attempts 未写回），下批再试，不 pretend 已丢弃。
          warn("signal_drop_failed")
          return { attempts, dropped: false }
        }
      }
      const updated: MemoryQueueRecord = { ...rec, attempts, updatedAt: new Date().toISOString() }
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
      try {
        await writeFile(tmp, `${JSON.stringify(updated)}\n`, "utf8")
        await rename(tmp, file)
      } catch (e) {
        warn("signal_no_docs_write_failed")
        await unlink(tmp).catch(() => undefined)
        throw e
      }
      return { attempts, dropped: false }
    } catch {
      return { attempts: 0, dropped: false }
    }
  })
}

/**
 * 追加审计 JSONL。只写事件元资料：`event/sessionId/kinds/stored/at`。
 * 绝不写 sample 或任何正文；失败只 warn，不抛。
 */
export async function appendMemoryAudit(event: MemoryAuditEvent): Promise<void> {
  try {
    if (!event || typeof event !== "object") return
    const allowed: Array<MemoryAuditEvent["event"]> = [
      "enqueue",
      "stored",
      "no_docs",
      "drained",
      "dropped_after_attempts",
    ]
    if (!allowed.includes(event.event)) {
      warn("audit_bad_event")
      return
    }
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : ""
    if (!sessionId) {
      warn("audit_missing_session")
      return
    }
    const line: Record<string, unknown> = {
      event: event.event,
      sessionId,
      at: new Date().toISOString(),
    }
    if (Array.isArray(event.kinds) && event.kinds.length > 0) line.kinds = event.kinds
    if (typeof event.stored === "number" && Number.isFinite(event.stored)) {
      line.stored = Math.max(0, Math.floor(event.stored))
    }
    const dir = await resolveMemoryQueueDir()
    await appendFile(join(dir, MEMORY_AUDIT_FILENAME), `${JSON.stringify(line)}\n`, "utf8")
  } catch {
    warn("audit_append_failed")
  }
}
