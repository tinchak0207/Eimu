// LongMemEval 检索评测（零 LLM）：每题把 haystack 入 chat-history-search 索引，查 question，
// 看 answer_session_ids 是否进 top-k 会话。用法：
//   node tools/memory-bench/lme-retrieval.mjs [--file s|oracle] [--limit N] [--k 5,10] [--ctx 1] [--json out.json]
import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ensureHistorySchema, indexTurns, searchHistory } from "../../services/gateway/chat-history-search.ts"

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1] ?? "1"]] : a), []))
const file = args.file === "oracle" ? "longmemeval_oracle.json" : "longmemeval_s_cleaned.json"
const ks = String(args.k ?? "1,3,5,10").split(",").map(Number)
const ctx = Number(args.ctx ?? 1)
const limit = Number(args.limit ?? 0)
const data = JSON.parse(readFileSync(`${process.env.HOME}/bench-sources/longmemeval/${file}`, "utf8"))

function parseDate(s) {
  const m = String(s).match(/(\d{4})\/(\d{2})\/(\d{2})(?:\s*\([A-Za-z]+\))?\s*(\d{2}):(\d{2})/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : Date.now()
}

const stats = {}
const t0 = Date.now()
let n = 0
for (const item of data) {
  if (limit && n >= limit) break
  if (String(item.question_id).endsWith("_abs")) continue
  n += 1
  const db = new DatabaseSync(":memory:")
  ensureHistorySchema(db)
  const owner = "bench"
  const turns = []
  item.haystack_sessions.forEach((sess, si) => {
    const base = parseDate(item.haystack_dates[si])
    sess.forEach((t, ti) => turns.push({ ownerKey: owner, sessionId: item.haystack_session_ids[si], turnIdx: ti, role: t.role === "user" ? "user" : "assistant", text: t.content, ts: base + ti * 1000 }))
  })
  indexTurns(db, turns)
  const hits = searchHistory(db, { ownerKey: owner, query: item.question, now: parseDate(item.question_date), limit: Math.max(...ks) * 2, context: ctx, timeBoost: args.tb ? Number(args.tb) : undefined })
  const seen = []
  for (const h of hits) if (!seen.includes(h.sessionId)) seen.push(h.sessionId)
  const answers = new Set(item.answer_session_ids)
  const type = item.question_type
  const s = (stats[type] ??= { n: 0, ...Object.fromEntries(ks.map((k) => [`r@${k}`, 0])), any: 0 })
  s.n += 1
  for (const k of ks) {
    const top = seen.slice(0, k)
    // 全召回：所有答案会话都进 top-k（多会话题的严格口径）
    if ([...answers].every((a) => top.includes(a))) s[`r@${k}`] += 1
  }
  db.close()
  if (n % 50 === 0) console.error(`${n} done ${(Date.now() - t0) / 1000}s`)
}
const total = { n: 0, ...Object.fromEntries(ks.map((k) => [`r@${k}`, 0])) }
for (const s of Object.values(stats)) { total.n += s.n; for (const k of ks) total[`r@${k}`] += s[`r@${k}`] }
const fmt = (s) => `n=${s.n} ` + ks.map((k) => `r@${k}=${((s[`r@${k}`] / s.n) * 100).toFixed(1)}%`).join(" ")
for (const [t, s] of Object.entries(stats)) console.log(t.padEnd(28), fmt(s))
console.log("ALL".padEnd(28), fmt(total), `${((Date.now() - t0) / 1000).toFixed(0)}s`)
if (args.json) writeFileSync(args.json, JSON.stringify({ stats, total }, null, 1))
