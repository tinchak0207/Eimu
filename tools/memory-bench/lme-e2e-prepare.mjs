// LongMemEval 端到端评测·第 1 段（本机、零 LLM）：分层抽样 → 用 chat-history-search 检索 top 会话 → 产出 reader 输入。
// 第 2 段（reader＋judge，需要渠道配置，只在 VPS 上跑）见 lme-e2e-run.mjs。
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tools/memory-bench/lme-e2e-prepare.mjs --per-type 10 --topk 5 --out /tmp/lme-e2e-input.json
import { readFileSync, writeFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ensureHistorySchema, indexTurns, searchHistory } from "../../deploy-staging/gateway/chat-history-search.ts"

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1] ?? "1"]] : a), []))
const perType = Number(args["per-type"] ?? 10)
const topk = Number(args.topk ?? 5)
const maxSessionChars = Number(args["session-chars"] ?? 9000)
const data = JSON.parse(readFileSync(`${process.env.HOME}/bench-sources/longmemeval/longmemeval_s_cleaned.json`, "utf8"))

function parseDate(s) {
  const m = String(s).match(/(\d{4})\/(\d{2})\/(\d{2})(?:\s*\([A-Za-z]+\))?\s*(\d{2}):(\d{2})/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : Date.now()
}

// 分层抽样（确定性：每类型按出现顺序隔 step 取，避免只取前 N 个的偏差）；弃权题（_abs）不入检索评测，但保留少量用于误答率。
const byType = {}
for (const item of data) (byType[item.question_type] ??= []).push(item)
const picked = []
for (const [, items] of Object.entries(byType)) {
  const normal = items.filter((x) => !String(x.question_id).endsWith("_abs"))
  const step = Math.max(1, Math.floor(normal.length / perType))
  for (let i = 0, c = 0; i < normal.length && c < perType; i += step, c += 1) picked.push(normal[i])
}

const out = []
for (const item of picked) {
  const db = new DatabaseSync(":memory:")
  ensureHistorySchema(db)
  const sessionsById = new Map()
  const turns = []
  item.haystack_sessions.forEach((sess, si) => {
    const sid = item.haystack_session_ids[si]
    const base = parseDate(item.haystack_dates[si])
    sessionsById.set(sid, { date: item.haystack_dates[si], turns: sess })
    sess.forEach((t, ti) => turns.push({ ownerKey: "bench", sessionId: sid, turnIdx: ti, role: t.role === "user" ? "user" : "assistant", text: t.content, ts: base + ti * 1000 }))
  })
  indexTurns(db, turns)
  const hits = searchHistory(db, { ownerKey: "bench", query: item.question, now: parseDate(item.question_date), limit: topk * 4, context: 1 })
  const order = []
  for (const h of hits) if (!order.includes(h.sessionId)) order.push(h.sessionId)
  const top = order.slice(0, topk)
  // reader 看到的是「命中会话的原文」（与 Eimu 的 chat_history_search 展开一致：先 snippet 命中，再按需读全会话），按时间升序摆放。
  const ctxSessions = top
    .map((sid) => sessionsById.get(sid))
    .sort((a, b) => parseDate(a.date) - parseDate(b.date))
    .map((s) => ({ date: s.date, text: s.turns.map((t) => `${t.role}: ${t.content}`).join("\n").slice(0, maxSessionChars) }))
  out.push({
    question_id: item.question_id,
    type: item.question_type,
    question: item.question,
    question_date: item.question_date,
    answer: item.answer,
    retrieved: top,
    answer_sessions: item.answer_session_ids,
    session_hit: item.answer_session_ids.every((a) => top.includes(a)),
    sessions: ctxSessions,
  })
  db.close()
}
writeFileSync(args.out ?? "/tmp/lme-e2e-input.json", JSON.stringify(out))
const hit = out.filter((x) => x.session_hit).length
console.log(`questions=${out.length} retrieval_all_answer_sessions@${topk}=${hit}/${out.length}`)
