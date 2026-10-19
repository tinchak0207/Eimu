// 结构化评审 Findings（ReportFindings）：CC 2.1.302 取证语义的批次落库。
// 约束：
// - 一次调用报完；findings 最多 32 条，按严重度从高到低。
// - 整批校验通过才在**单事务**内写入；任一字段非法则整批拒绝并回报具体字段。
// - 空数组合法（表示「没有存活的问题」）。
// - 只有调用方显式给 run_id 时，同一 (session_id, run_id) 才视为同一批次：重复上报整批替换（幂等）。
// - 未给 run_id 时**每次上报生成独立批次 id**（时间戳+随机），多个 critic 连续上报不会互相覆盖。
// - 只用 SESSIONS_DB_PATH 同一持久库（与 job-store.ts 同配方），不另立状态目录。
import { Database } from "bun:sqlite"

export const FINDINGS_MAX_ITEMS = 32
/** short_summary 按 UTF-16 长度计（emoji 算 2）。 */
export const SHORT_SUMMARY_MAX_CHARS = 60
export const FINDING_FILE_MAX_CHARS = 512
export const FINDING_SUMMARY_MAX_CHARS = 4000
export const FINDING_FAILURE_SCENARIO_MAX_CHARS = 4000
export const FINDING_CATEGORY_MAX_CHARS = 40

export type FindingLevel = "low" | "medium" | "high" | "xhigh" | "max"
export type FindingVerdict = "CONFIRMED" | "PLAUSIBLE"
export type FindingOutcome = "fixed" | "skipped" | "no_change_needed"

const LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"])
const VERDICTS: ReadonlySet<string> = new Set(["CONFIRMED", "PLAUSIBLE"])
const OUTCOMES: ReadonlySet<string> = new Set(["fixed", "skipped", "no_change_needed"])
const CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface ReviewFinding {
  id: number
  session_id: string
  run_id: string | null
  level: FindingLevel | null
  file: string
  line: number | null
  summary: string
  short_summary: string | null
  failure_scenario: string
  category: string | null
  verdict: FindingVerdict | null
  outcome: FindingOutcome | null
  created_at: number
}

export interface ReportFindingsInput {
  /** 边界输入：HTTP/tool 传来的值必须先校验。 */
  level?: unknown
  findings: unknown
  run_id?: unknown
}

export interface FindingsFieldError {
  index?: number
  field: string
  message: string
}

export class FindingsValidationError extends Error {
  readonly errors: FindingsFieldError[]
  constructor(errors: FindingsFieldError[]) {
    super(errors.map((e) => `${e.field}: ${e.message}`).join("; "))
    this.name = "FindingsValidationError"
    this.errors = errors
  }
}

interface NormalizedFinding {
  file: string
  line: number | null
  summary: string
  short_summary: string | null
  failure_scenario: string
  category: string | null
  verdict: FindingVerdict | null
  outcome: FindingOutcome | null
}

let connection: Database | undefined
function db(): Database {
  if (connection) return connection
  const next = new Database(process.env.SESSIONS_DB_PATH || "/opt/eimu-harness/state/sessions.db", { create: true })
  next.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
  next.exec(`CREATE TABLE IF NOT EXISTS review_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    run_id TEXT,
    level TEXT,
    file TEXT NOT NULL,
    line INTEGER,
    summary TEXT NOT NULL,
    short_summary TEXT,
    failure_scenario TEXT NOT NULL,
    category TEXT,
    verdict TEXT,
    outcome TEXT,
    created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS review_findings_session_created ON review_findings(session_id,created_at);
    CREATE INDEX IF NOT EXISTS review_findings_session_run ON review_findings(session_id,run_id);`)
  connection = next
  return next
}

function decode(row: any): ReviewFinding {
  return {
    id: Number(row.id),
    session_id: String(row.session_id),
    run_id: row.run_id ?? null,
    level: LEVELS.has(String(row.level)) ? (String(row.level) as FindingLevel) : null,
    file: String(row.file),
    line: row.line === null || row.line === undefined ? null : Number(row.line),
    summary: String(row.summary),
    short_summary: row.short_summary ?? null,
    failure_scenario: String(row.failure_scenario),
    category: row.category ?? null,
    verdict: VERDICTS.has(String(row.verdict)) ? (String(row.verdict) as FindingVerdict) : null,
    outcome: OUTCOMES.has(String(row.outcome)) ? (String(row.outcome) as FindingOutcome) : null,
    created_at: Number(row.created_at),
  }
}

function requireSessionId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : ""
  if (!id) throw new FindingsValidationError([{ field: "session_id", message: "不能为空" }])
  return id
}

/** 仓库相对路径：拒绝绝对路径、盘符（含 `C:x.ts` 这种盘符相对）、UNC、控制字符与 `..` 路径段。 */
function repoRelativeError(file: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(file)) return "不得包含 NUL/换行/控制字符"
  if (file.startsWith("/") || file.startsWith("\\")) return "必须是仓库相对路径，不得是绝对路径"
  if (/^[a-zA-Z]:/.test(file)) return "必须是仓库相对路径，不得带盘符"
  if (file.split(/[\\/]/).includes("..")) return "不得包含 `..` 路径段"
  return null
}

function readString(
  rec: Record<string, unknown>,
  key: string,
  field: string,
  errors: FindingsFieldError[],
  required: boolean,
): string | null {
  const raw = rec[key]
  if (raw === undefined || raw === null) {
    if (required) errors.push({ field, message: "必填" })
    return null
  }
  if (typeof raw !== "string") {
    errors.push({ field, message: "必须是字符串" })
    return null
  }
  const value = raw.trim()
  if (!value) {
    if (required) errors.push({ field, message: "不能为空" })
    return null
  }
  return value
}

function normalizeFinding(raw: unknown, index: number, errors: FindingsFieldError[]): NormalizedFinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push({ index, field: `findings[${index}]`, message: "必须是对象" })
    return null
  }
  const rec = raw as Record<string, unknown>
  const before = errors.length
  const prefix = `findings[${index}]`

  // file：必填 + 仓库相对路径。
  const fileField = `${prefix}.file`
  const file = readString(rec, "file", fileField, errors, true)
  if (file) {
    const pathError = repoRelativeError(file)
    if (pathError) errors.push({ index, field: fileField, message: pathError })
    else if (file.length > FINDING_FILE_MAX_CHARS) {
      errors.push({ index, field: fileField, message: `最多 ${FINDING_FILE_MAX_CHARS} 字符（当前 ${file.length}）` })
    }
  }

  // line：1-based 正整数。
  let line: number | null = null
  if (rec.line !== undefined && rec.line !== null) {
    if (typeof rec.line !== "number" || !Number.isInteger(rec.line) || rec.line < 1) {
      errors.push({ index, field: `${prefix}.line`, message: "必须是 1-based 正整数" })
    } else {
      line = rec.line
    }
  }

  const summary = readString(rec, "summary", `${prefix}.summary`, errors, true)
  if (summary && summary.length > FINDING_SUMMARY_MAX_CHARS) {
    errors.push({
      index,
      field: `${prefix}.summary`,
      message: `最多 ${FINDING_SUMMARY_MAX_CHARS} 字符（当前 ${summary.length}）`,
    })
  }
  const failureScenario = readString(rec, "failure_scenario", `${prefix}.failure_scenario`, errors, true)
  if (failureScenario && failureScenario.length > FINDING_FAILURE_SCENARIO_MAX_CHARS) {
    errors.push({
      index,
      field: `${prefix}.failure_scenario`,
      message: `最多 ${FINDING_FAILURE_SCENARIO_MAX_CHARS} 字符（当前 ${failureScenario.length}）`,
    })
  }

  // short_summary：≤60 字符（UTF-16 长度），只讲主张。
  let shortSummary: string | null = null
  if (rec.short_summary !== undefined && rec.short_summary !== null) {
    if (typeof rec.short_summary !== "string") {
      errors.push({ index, field: `${prefix}.short_summary`, message: "必须是字符串" })
    } else {
      const value = rec.short_summary.trim()
      if (value) {
        if (value.length > SHORT_SUMMARY_MAX_CHARS) {
          errors.push({
            index,
            field: `${prefix}.short_summary`,
            message: `最多 ${SHORT_SUMMARY_MAX_CHARS} 字符（UTF-16 长度，当前 ${value.length}）`,
          })
        } else {
          shortSummary = value
        }
      }
    }
  }

  // category：kebab-case，≤40 字符。
  let category: string | null = null
  if (rec.category !== undefined && rec.category !== null) {
    if (typeof rec.category !== "string" || !CATEGORY_PATTERN.test(rec.category.trim())) {
      errors.push({ index, field: `${prefix}.category`, message: "必须是 kebab-case（如 correctness / test-coverage）" })
    } else if (rec.category.trim().length > FINDING_CATEGORY_MAX_CHARS) {
      errors.push({
        index,
        field: `${prefix}.category`,
        message: `最多 ${FINDING_CATEGORY_MAX_CHARS} 字符（当前 ${rec.category.trim().length}）`,
      })
    } else {
      category = rec.category.trim()
    }
  }

  // verdict / outcome：枚举。
  let verdict: FindingVerdict | null = null
  if (rec.verdict !== undefined && rec.verdict !== null) {
    if (typeof rec.verdict !== "string" || !VERDICTS.has(rec.verdict)) {
      errors.push({ index, field: `${prefix}.verdict`, message: "只能是 CONFIRMED 或 PLAUSIBLE" })
    } else {
      verdict = rec.verdict as FindingVerdict
    }
  }
  let outcome: FindingOutcome | null = null
  if (rec.outcome !== undefined && rec.outcome !== null) {
    if (typeof rec.outcome !== "string" || !OUTCOMES.has(rec.outcome)) {
      errors.push({
        index,
        field: `${prefix}.outcome`,
        message: "只能是 fixed / skipped / no_change_needed",
      })
    } else {
      outcome = rec.outcome as FindingOutcome
    }
  }

  if (errors.length > before || !file || !summary || !failureScenario) return null
  return {
    file,
    line,
    summary,
    short_summary: shortSummary,
    failure_scenario: failureScenario,
    category,
    verdict,
    outcome,
  }
}

/**
 * 一次提交整批评审问题。校验失败整批拒绝（抛 FindingsValidationError）；
 * 成功则单事务写入，返回 {ok:true,count}。
 */
export function reportFindings(sessionId: string, input: ReportFindingsInput): { ok: true; count: number; run_id: string } {
  const sid = requireSessionId(sessionId)
  const errors: FindingsFieldError[] = []

  const levelRaw = input.level
  let level: FindingLevel | null = null
  if (levelRaw !== undefined && levelRaw !== null && levelRaw !== "") {
    if (typeof levelRaw !== "string" || !LEVELS.has(levelRaw)) {
      errors.push({ field: "level", message: "只能是 low / medium / high / xhigh / max" })
    } else {
      level = levelRaw as FindingLevel
    }
  }

  const runIdRaw = input.run_id
  let runId: string | null = null
  if (runIdRaw !== undefined && runIdRaw !== null && runIdRaw !== "") {
    if (typeof runIdRaw !== "string") errors.push({ field: "run_id", message: "必须是字符串" })
    else if (runIdRaw.trim()) runId = runIdRaw.trim()
  }

  if (!Array.isArray(input.findings)) {
    errors.push({ field: "findings", message: "必须是数组（没有存活的问题时传空数组）" })
    throw new FindingsValidationError(errors)
  }
  if (input.findings.length > FINDINGS_MAX_ITEMS) {
    errors.push({ field: "findings", message: `最多 ${FINDINGS_MAX_ITEMS} 条（当前 ${input.findings.length}）` })
  }

  const normalized: NormalizedFinding[] = []
  input.findings.slice(0, FINDINGS_MAX_ITEMS).forEach((raw, index) => {
    const finding = normalizeFinding(raw, index, errors)
    if (finding) normalized.push(finding)
  })

  if (errors.length > 0) throw new FindingsValidationError(errors)

  // P1-3：只有显式 run_id 才按批替换；未给时每次生成独立批次 id，
  // 否则多个 critic 会用同一个 `auto:<sid>` 互相 DELETE（只留最后一批）。
  const now = Date.now()
  const explicitRunId = runId !== null
  const effectiveRunId = runId ?? `auto:${sid}:${now.toString(36)}:${crypto.randomUUID().slice(0, 8)}`
  const database = db()
  const insert = database.query(
    `INSERT INTO review_findings(
      session_id,run_id,level,file,line,summary,short_summary,failure_scenario,category,verdict,outcome,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  database.transaction(() => {
    if (explicitRunId) {
      database.query("DELETE FROM review_findings WHERE session_id=? AND run_id=?").run(sid, effectiveRunId)
    }
    for (const f of normalized) {
      insert.run(
        sid,
        effectiveRunId,
        level,
        f.file,
        f.line,
        f.summary,
        f.short_summary,
        f.failure_scenario,
        f.category,
        f.verdict,
        f.outcome,
        now,
      )
    }
  })()
  return { ok: true, count: normalized.length, run_id: effectiveRunId }
}

/** 最近 N 条（跨 run，created_at 新的在前；同一批次内按提交顺序）。 */
export function listFindings(sessionId: string, limit = 100): ReviewFinding[] {
  const sid = requireSessionId(sessionId)
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 100
  const rows = db()
    .query("SELECT * FROM review_findings WHERE session_id=? ORDER BY created_at DESC, id ASC LIMIT ?")
    .all(sid, n) as any[]
  return rows.map(decode)
}

/** 最近一次评审批次（按 run_id 聚组，COUNT(*) 不跨批次合并）；无记录时 undefined。 */
export function latestFindingsRun(
  sessionId: string,
): { run_id: string | null; level: FindingLevel | null; created_at: number; count: number } | undefined {
  const sid = requireSessionId(sessionId)
  const row = db()
    .query(
      `SELECT f1.run_id,
              (SELECT f2.level FROM review_findings f2
                WHERE f2.session_id=f1.session_id AND f2.run_id IS f1.run_id
                ORDER BY f2.id DESC LIMIT 1) AS level,
              MAX(f1.created_at) AS created_at,
              COUNT(*) AS count
       FROM review_findings f1 WHERE f1.session_id=?
       GROUP BY f1.run_id
       ORDER BY created_at DESC, MAX(f1.id) DESC LIMIT 1`,
    )
    .get(sid) as any
  if (!row) return undefined
  return {
    run_id: row.run_id ?? null,
    level: LEVELS.has(String(row.level)) ? (String(row.level) as FindingLevel) : null,
    created_at: Number(row.created_at),
    count: Number(row.count),
  }
}
