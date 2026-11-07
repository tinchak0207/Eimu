/**
 * chat-history-search.ts — 历史对话检索（"reference chat history"）。
 *
 * 对标 ChatGPT「参考聊天记录」：新会话里能找回以前会话说过什么。
 * 零 embedding：SQLite FTS5(unicode61)＋预分词（CJK bigram／英文词干），BM25 排序；
 * 会话级聚合、相对时间识别、命中轮±邻轮窗口。
 *
 * 纯模块：不 import 网关其它文件；DB 句柄注入（bun:sqlite 与 node:sqlite 皆可，
 * 只用 exec/prepare().run/all/get）。所有读写必带 ownerKey——owner 作为 FTS 词项
 * 参与 MATCH（索引内裁剪），查询另有 owner_key 二次校验，双保险隔离。
 */
import { createHash } from "node:crypto"

export interface Db {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
    get(...args: unknown[]): unknown
  }
}

export interface HistoryTurn {
  ownerKey: string
  sessionId: string
  turnIdx: number
  role: "user" | "assistant"
  text: string
  /** 毫秒时间戳 */
  ts: number
  sessionTitle?: string
}

export interface HistoryHit {
  sessionId: string
  sessionTitle?: string
  turnIdx: number
  ts: number
  role: "user" | "assistant"
  score: number
  /** 命中轮±邻轮，已按预算截断。 */
  snippet: string
}

export interface HistoryQuery {
  ownerKey: string
  query: string
  now?: number
  limit?: number
  since?: number
  until?: number
  excludeSessionIds?: string[]
  maxSnippetChars?: number
  /** 命中轮前后各带几轮（默认 1）。 */
  context?: number
  /** 相对时间命中窗口内的加权倍数（默认 1.25；1＝关闭）。 */
  timeBoost?: number
}

// ─────────────────────────── 分词
const STOP = new Set(
  (
    "a an the and or but if then than that this these those is are was were be been being am do does did done doing have has had having " +
    "i me my mine we us our you your he him his she her it its they them their what which who whom whose when where why how " +
    "of in on at to for from by with about into over after before between out up down off as so not no yes can could would should will shall may might must " +
    "there here also just very really any some all more most other such only own same too s t don now " +
    "tell remind remember told say said ask asked talk talked mention mentioned earlier previously ago"
  ).split(" "),
)
const CJK_STOP = new Set(["的", "了", "是", "我", "你", "他", "她", "它", "吗", "呢", "吧", "啊", "和", "与", "在", "有", "就", "也", "都", "要", "会", "这", "那", "么", "什么", "怎么", "一个", "我们", "你们", "之前", "上次", "还记得", "记得", "说过", "聊过", "提到"])

function stem(w: string): string {
  if (w.length <= 3) return w
  if (/^\d+$/.test(w)) return w
  let s = w
  if (s.endsWith("ies") && s.length > 4) return s.slice(0, -3) + "y"
  if (s.endsWith("sses")) return s.slice(0, -2)
  if (s.endsWith("ing") && s.length > 5) s = s.slice(0, -3)
  else if (s.endsWith("ed") && s.length > 4) s = s.slice(0, -2)
  else if (s.endsWith("es") && s.length > 4) s = s.slice(0, -2)
  else if (s.endsWith("s") && !s.endsWith("ss") && s.length > 3) s = s.slice(0, -1)
  if (s.length > 3 && s[s.length - 1] === s[s.length - 2] && !/[lsz]/.test(s[s.length - 1])) s = s.slice(0, -1)
  return s
}

const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g

/** 预分词。query=true 时过滤停用词。 */
export function historyTokens(text: string, query = false): string[] {
  const source = String(text ?? "")
  const out: string[] = []
  for (const w of source.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (query && (STOP.has(w) || w.length < 2) && !/^\d+$/.test(w)) continue
    out.push(stem(w))
  }
  for (const run of source.match(CJK_RUN) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) {
      if (!(query && CJK_STOP.has(run))) out.push(run)
      continue
    }
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const bg = chars[i] + chars[i + 1]
      if (query && CJK_STOP.has(bg)) continue
      out.push(bg)
    }
  }
  return out
}

function ownerTerm(ownerKey: string): string {
  return "zzowner" + createHash("sha1").update(ownerKey).digest("hex").slice(0, 16)
}

// ─────────────────────────── schema／写入
export function ensureHistorySchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id        INTEGER PRIMARY KEY,
      owner_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_idx  INTEGER NOT NULL,
      role      TEXT NOT NULL,
      text      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      title     TEXT,
      UNIQUE(owner_key, session_id, turn_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_history_ts ON chat_history(owner_key, ts);
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_history_fts USING fts5(tok, tokenize='unicode61 remove_diacritics 0');
  `)
}

export function indexTurns(db: Db, turns: HistoryTurn[]): { inserted: number; skipped: number } {
  let inserted = 0
  let skipped = 0
  const exists = db.prepare("SELECT 1 AS hit FROM chat_history WHERE owner_key=? AND session_id=? AND turn_idx=?")
  const ins = db.prepare("INSERT INTO chat_history(owner_key, session_id, turn_idx, role, text, ts, title) VALUES (?,?,?,?,?,?,?)")
  const last = db.prepare("SELECT id FROM chat_history WHERE owner_key=? AND session_id=? AND turn_idx=?")
  const insFts = db.prepare("INSERT INTO chat_history_fts(rowid, tok) VALUES (?, ?)")
  db.exec("BEGIN")
  try {
    for (const t of turns) {
      if (!t.ownerKey || !t.sessionId || !t.text || !t.text.trim()) {
        skipped += 1
        continue
      }
      if (exists.get(t.ownerKey, t.sessionId, t.turnIdx)) {
        skipped += 1
        continue
      }
      ins.run(t.ownerKey, t.sessionId, t.turnIdx, t.role, t.text, Math.trunc(t.ts), t.sessionTitle ?? null)
      const row = last.get(t.ownerKey, t.sessionId, t.turnIdx) as { id: number }
      insFts.run(row.id, `${ownerTerm(t.ownerKey)} ${historyTokens(t.text).join(" ")}`)
      inserted += 1
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  return { inserted, skipped }
}

export function sessionIndexedCount(db: Db, ownerKey: string, sessionId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM chat_history WHERE owner_key=? AND session_id=?").get(ownerKey, sessionId) as { n: number }
  return Number(row?.n ?? 0)
}

/** 该 owner 已索引的会话数与轮数（状态面板用）。 */
export function ownerHistoryStats(db: Db, ownerKey: string): { sessions: number; turns: number } {
  const row = db.prepare("SELECT COUNT(DISTINCT session_id) AS s, COUNT(*) AS n FROM chat_history WHERE owner_key=?").get(ownerKey) as { s: number; n: number }
  return { sessions: Number(row?.s ?? 0), turns: Number(row?.n ?? 0) }
}

function deleteWhere(db: Db, where: string, ...args: unknown[]): number {
  const ids = db.prepare(`SELECT id FROM chat_history WHERE ${where}`).all(...args) as Array<{ id: number }>
  if (ids.length === 0) return 0
  const delFts = db.prepare("DELETE FROM chat_history_fts WHERE rowid=?")
  const delRow = db.prepare("DELETE FROM chat_history WHERE id=?")
  db.exec("BEGIN")
  try {
    for (const { id } of ids) {
      delFts.run(id)
      delRow.run(id)
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  return ids.length
}

export function deleteSessionHistory(db: Db, ownerKey: string, sessionId: string): number {
  return deleteWhere(db, "owner_key=? AND session_id=?", ownerKey, sessionId)
}

/**
 * 「忘掉」联动：删记忆时，把历史对话索引里复述了同一事实的轮次一并抹掉，否则换个会话一问还能从流水里捞回来。
 * 判据：needle 的检索词有 ≥containment 落在某一轮里（该轮是用户原话或助手复述）；紧随其后的助手轮用更低的门槛（回复多半换了说法）。
 * 只删索引里的轮次，不动对话本身。needle 太短（<3 个检索词）不处理，宁可少删也不误伤。
 */
export function forgetHistoryContaining(db: Db, ownerKey: string, needles: string[], opts: { containment?: number; replyContainment?: number } = {}): number {
  const containment = opts.containment ?? 0.6
  const replyContainment = opts.replyContainment ?? 0.35
  const doomed = new Set<number>()
  const getTurn = db.prepare("SELECT id, role, text FROM chat_history WHERE owner_key=? AND session_id=? AND turn_idx=?")
  const share = (needle: Set<string>, text: string): number => {
    let hit = 0
    const have = new Set(historyTokens(text, true))
    for (const t of needle) if (have.has(t)) hit += 1
    return hit / needle.size
  }
  // 记忆正文是模型转述，常比用户原话长或换了说法：原话（较短一方）的词被记忆正文覆盖得够多，也算同一件事。
  const covered = (needle: Set<string>, text: string): number => {
    const have = new Set(historyTokens(text, true))
    if (have.size < 6) return 0
    let hit = 0
    for (const t of have) if (needle.has(t)) hit += 1
    return hit / have.size
  }
  for (const raw of needles) {
    const text = String(raw ?? "").trim()
    const needle = new Set(historyTokens(text, true))
    if (needle.size < 3) continue
    const hits = searchHistory(db, { ownerKey, query: text.slice(0, 400), now: Date.now(), limit: 40, context: 0, timeBoost: 1 })
    const seen = new Set<string>()
    for (const h of hits) {
      const k = `${h.sessionId}\u0000${h.turnIdx}`
      if (seen.has(k)) continue
      seen.add(k)
      const row = getTurn.get(ownerKey, h.sessionId, h.turnIdx) as { id: number; role: string; text: string } | undefined
      if (!row || (row.role === "user" ? Math.max(share(needle, row.text), covered(needle, row.text)) : share(needle, row.text)) < containment) continue
      doomed.add(row.id)
      const next = getTurn.get(ownerKey, h.sessionId, h.turnIdx + 1) as { id: number; role: string; text: string } | undefined
      if (next && next.role === "assistant" && share(needle, next.text) >= replyContainment) doomed.add(next.id)
    }
  }
  if (doomed.size === 0) return 0
  const delFts = db.prepare("DELETE FROM chat_history_fts WHERE rowid=?")
  const delRow = db.prepare("DELETE FROM chat_history WHERE id=?")
  db.exec("BEGIN")
  try {
    for (const id of doomed) {
      delFts.run(id)
      delRow.run(id)
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  return doomed.size
}

/** 一次性迁移：改写已入库的 user 轮正文（剥掉网关注入尾巴），同步重建 FTS 词；剥空则整行删除。 */
export function rewriteUserHistoryText(db: Db, marker: string, transform: (text: string) => string): number {
  const rows = db.prepare("SELECT id, owner_key, text FROM chat_history WHERE role='user' AND text LIKE ?").all(`%${marker}%`) as Array<{ id: number; owner_key: string; text: string }>
  if (rows.length === 0) return 0
  const delFts = db.prepare("DELETE FROM chat_history_fts WHERE rowid=?")
  const insFts = db.prepare("INSERT INTO chat_history_fts(rowid, tok) VALUES (?, ?)")
  const upd = db.prepare("UPDATE chat_history SET text=? WHERE id=?")
  const delRow = db.prepare("DELETE FROM chat_history WHERE id=?")
  let changed = 0
  db.exec("BEGIN")
  try {
    for (const r of rows) {
      const next = transform(r.text)
      if (next === r.text) continue
      delFts.run(r.id)
      if (!next.trim()) delRow.run(r.id)
      else {
        upd.run(next, r.id)
        insFts.run(r.id, `${ownerTerm(r.owner_key)} ${historyTokens(next).join(" ")}`)
      }
      changed += 1
    }
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  return changed
}

export function deleteOwnerHistory(db: Db, ownerKey: string): number {
  return deleteWhere(db, "owner_key=?", ownerKey)
}

// ─────────────────────────── 相对时间识别
const DAY = 86_400_000
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

const EN_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 }
function cnNum(s: string): number {
  if (EN_NUM[s] !== undefined) return EN_NUM[s]
  if (/^\d+$/.test(s)) return Number(s)
  if (s === "十") return 10
  if (s.length === 2 && s[0] === "十") return 10 + (CN_NUM[s[1]] ?? 0)
  if (s.length === 2 && s[1] === "十") return (CN_NUM[s[0]] ?? 0) * 10
  return CN_NUM[s] ?? 0
}

/** 从问句里识别相对时间 → [since, until)（毫秒）。识别不出返回 null。 */
export function parseTimeRange(query: string, now: number): { since: number; until: number } | null {
  const q = query.toLowerCase()
  const startOfDay = (t: number) => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const today = startOfDay(now)
  let m: RegExpMatchArray | null
  if (/昨天|yesterday/.test(q)) return { since: today - DAY, until: today }
  if (/前天/.test(q)) return { since: today - 2 * DAY, until: today - DAY }
  if (/今天|today|this morning|tonight/.test(q)) return { since: today, until: today + DAY }
  if (/上上(周|个星期|星期)/.test(q)) return { since: today - 21 * DAY, until: today - 7 * DAY }
  if (/上(周|个星期|星期)|last week/.test(q)) return { since: today - 14 * DAY, until: today - 0 * DAY }
  if (/本周|这周|这个星期|this week/.test(q)) return { since: today - 7 * DAY, until: today + DAY }
  if (/上个月|上月|last month/.test(q)) return { since: today - 62 * DAY, until: today - 0 * DAY }
  if (/这个月|本月|this month/.test(q)) return { since: today - 31 * DAY, until: today + DAY }
  if (/去年|last year/.test(q)) return { since: today - 800 * DAY, until: today - 150 * DAY }
  if ((m = q.match(/([0-9]+|[一二两三四五六七八九十]{1,3})\s*(?:天|日)前/)) || (m = q.match(/\b(\d+|an?|one|two|three|four|five|six|seven|ten|couple of|few)\s*days? ago/))) {
    const n = cnNum(m[1].replace(/ of$/, ""))
    if (n > 0) return { since: today - (n + 2) * DAY, until: today - Math.max(0, n - 2) * DAY }
  }
  if ((m = q.match(/([0-9]+|[一二两三四五六七八九十]{1,3})\s*(?:周|个星期|星期)前/)) || (m = q.match(/\b(\d+|an?|one|two|three|four|five|six|seven|eight|couple of|few)\s*weeks? ago/))) {
    const n = cnNum(m[1].replace(/ of$/, ""))
    if (n > 0) return { since: today - (n * 7 + 5) * DAY, until: today - Math.max(0, n * 7 - 5) * DAY }
  }
  if ((m = q.match(/([0-9]+|[一二两三四五六七八九十]{1,3})\s*个?月前/)) || (m = q.match(/\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple of|few)\s*months? ago/))) {
    const n = cnNum(m[1].replace(/ of$/, ""))
    if (n > 0) return { since: today - (n * 30 + 20) * DAY, until: today - Math.max(0, n * 30 - 20) * DAY }
  }
  for (let i = 0; i < MONTHS.length; i += 1) {
    const re = new RegExp(`\\b(?:in |during |last |this )?${MONTHS[i]}\\b(?:\\s+(\\d{4}))?`)
    if ((m = q.match(re))) {
      const year = m[1] ? Number(m[1]) : new Date(now).getFullYear() - (i > new Date(now).getMonth() ? 1 : 0)
      return { since: Date.UTC(year, i, 1), until: Date.UTC(year, i + 1, 1) }
    }
  }
  return null
}

// ─────────────────────────── 检索
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

interface Row {
  id: number
  session_id: string
  turn_idx: number
  role: "user" | "assistant"
  text: string
  ts: number
  title: string | null
  rank: number
}

export function searchHistory(db: Db, q: HistoryQuery): HistoryHit[] {
  if (!q.ownerKey) return []
  const now = q.now ?? Date.now()
  const limit = Math.max(1, Math.min(20, Math.trunc(q.limit ?? 5)))
  const maxChars = Math.max(200, Math.min(4000, Math.trunc(q.maxSnippetChars ?? 700)))
  const context = Math.max(0, Math.min(3, Math.trunc(q.context ?? 1)))
  const tokens = [...new Set(historyTokens(q.query, true))].slice(0, 48)
  if (tokens.length === 0) return []
  const match = `${ownerTerm(q.ownerKey)} AND (${tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ")})`
  const rows = db
    .prepare(
      `SELECT h.id, h.session_id, h.turn_idx, h.role, h.text, h.ts, h.title, bm25(chat_history_fts) AS rank
       FROM chat_history_fts f JOIN chat_history h ON h.id = f.rowid
       WHERE chat_history_fts MATCH ? AND h.owner_key = ?
       ORDER BY rank LIMIT 300`,
    )
    .all(match, q.ownerKey) as Row[]
  if (rows.length === 0) return []

  const exclude = new Set(q.excludeSessionIds ?? [])
  const range = parseTimeRange(q.query, now)
  const scored = rows
    .filter((r) => !exclude.has(r.session_id) && (q.since === undefined || r.ts >= q.since) && (q.until === undefined || r.ts < q.until))
    .map((r) => {
      let s = -r.rank
      if (range && r.ts >= range.since && r.ts < range.until) s *= q.timeBoost ?? 1.25
      return { r, s }
    })
  // 会话级聚合：最佳轮分＋次佳两轮的折扣和——同一会话多处命中说明主题吻合。
  const bySession = new Map<string, { best: number; sum: number; turns: Array<{ r: Row; s: number }> }>()
  for (const item of scored) {
    const g = bySession.get(item.r.session_id) ?? { best: 0, sum: 0, turns: [] }
    g.turns.push(item)
    bySession.set(item.r.session_id, g)
  }
  const sessions = [...bySession.entries()].map(([sid, g]) => {
    g.turns.sort((a, b) => b.s - a.s)
    const top = g.turns.slice(0, 3)
    const score = top[0].s + 0.35 * (top[1]?.s ?? 0) + 0.15 * (top[2]?.s ?? 0)
    return { sid, score, turns: g.turns }
  })
  sessions.sort((a, b) => b.score - a.score)

  const getWindow = db.prepare("SELECT turn_idx, role, text, ts FROM chat_history WHERE owner_key=? AND session_id=? AND turn_idx BETWEEN ? AND ? ORDER BY turn_idx")
  const hits: HistoryHit[] = []
  for (const sess of sessions) {
    if (hits.length >= limit) break
    // 每会话最多 2 个互不重叠的窗口（最佳 + 次佳且相距 > context*2+1 轮）
    const centers: Array<{ r: Row; s: number }> = []
    for (const t of sess.turns) {
      if (centers.every((c) => Math.abs(c.r.turn_idx - t.r.turn_idx) > context * 2 + 1)) centers.push(t)
      if (centers.length >= 2) break
    }
    for (const c of centers) {
      if (hits.length >= limit) break
      const win = getWindow.all(q.ownerKey, sess.sid, c.r.turn_idx - context, c.r.turn_idx + context) as Array<{ turn_idx: number; role: string; text: string; ts: number }>
      const centerBudget = Math.floor(maxChars * (win.length > 1 ? 0.6 : 1))
      const sideBudget = win.length > 1 ? Math.floor((maxChars - centerBudget) / Math.max(1, win.length - 1)) : 0
      const lines = win.map((w) => {
        const budget = w.turn_idx === c.r.turn_idx ? centerBudget : sideBudget
        const text = w.text.length > budget ? w.text.slice(0, Math.max(0, budget - 1)) + "…" : w.text
        return `[${fmtTime(w.ts)} ${w.role === "user" ? "用户" : "助理"}] ${text}`
      })
      hits.push({
        sessionId: sess.sid,
        sessionTitle: c.r.title ?? undefined,
        turnIdx: c.r.turn_idx,
        ts: c.r.ts,
        role: c.r.role,
        score: Number((c === centers[0] ? sess.score : c.s).toFixed(4)),
        snippet: lines.join("\n"),
      })
    }
  }
  return hits
}
