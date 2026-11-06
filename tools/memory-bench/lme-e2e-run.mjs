// LongMemEval 端到端评测·第 2 段（reader＋judge）：只在 VPS 上跑，渠道配置现场读取，绝不打印或落盘密钥。
//   node lme-e2e-run.mjs /tmp/lme-e2e-input.json /tmp/lme-e2e-result.json
// reader 提示词与 judge 判分口径沿用 LongMemEval 官方（evaluate_qa.py 的分类型 anscheck prompt）。
import { readFileSync, writeFileSync } from "node:fs"

// 角色 → 渠道:模型。reader 用便宜的 flash 档，judge 用独立的强模型（对齐官方「GPT-4o 判分」的独立性）。
const READER = (process.env.LME_READER ?? "a6api:deepseek-v4-flash").split(":")
const JUDGE = (process.env.LME_JUDGE ?? "shuai-gpt:gpt-5.6-sol").split(":")
const MODEL_ID = `reader=${READER.join("/")} judge=${JUDGE.join("/")}`
const CONCURRENCY = Number(process.env.LME_CONCURRENCY ?? 4)
const providers = JSON.parse(readFileSync("/opt/agent-harness/agent-models.json", "utf8"))?.providers ?? {}
function channel([provider, model]) {
  const o = providers[provider]?.options
  if (!o?.baseURL || !o?.apiKey) throw new Error(`channel ${provider} missing`)
  return { base: String(o.baseURL).replace(/\/$/, ""), apiKey: o.apiKey, model }
}
const readerCh = channel(READER)
const judgeCh = channel(JUDGE)

async function chat(role, system, user, maxTokens) {
  const ch = role === "judge" ? judgeCh : readerCh
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${ch.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ch.apiKey}` },
        body: JSON.stringify({ model: ch.model, ...(role === "judge" ? {} : { temperature: 0 }), max_tokens: maxTokens, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }] }),
        signal: AbortSignal.timeout(110_000),
      })
      if (!res.ok) throw new Error(`http_${res.status}`)
      const j = await res.json()
      const text = String(j?.choices?.[0]?.message?.content ?? "").trim()
      if (!text) throw new Error("empty")
      return { text, usage: j.usage ?? {} }
    } catch (e) {
      if (attempt === 2) return { text: "", error: String(e?.message ?? e).slice(0, 80), usage: {} }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
}

function readerPrompt(item) {
  const hist = item.sessions.map((s, i) => `### Session ${i + 1} (date: ${s.date})\n${s.text}`).join("\n\n")
  return `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer.\n\nHistory Chats:\n\n${hist}\n\nCurrent Date: ${item.question_date}\nQuestion: ${item.question}\nAnswer:`
}

function judgePrompt(item, response) {
  const tail = "Is the model response correct? Answer yes or no only."
  let rule = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no."
  if (item.type === "temporal-reasoning") rule += " In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct."
  if (item.type === "knowledge-update") rule += " If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer."
  if (item.type === "single-session-preference") rule = "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly."
  const label = item.type === "single-session-preference" ? "Rubric" : "Correct Answer"
  return `${rule}\n\nQuestion: ${item.question}\n\n${label}: ${item.answer}\n\nModel Response: ${response}\n\n${tail}`
}

const items = JSON.parse(readFileSync(process.argv[2], "utf8"))
const results = new Array(items.length)
let next = 0
const usage = { prompt: 0, completion: 0 }
async function worker() {
  while (next < items.length) {
    const i = next++
    const item = items[i]
    const r = await chat("reader", null, readerPrompt(item), 1200)
    usage.prompt += r.usage.prompt_tokens ?? 0
    usage.completion += r.usage.completion_tokens ?? 0
    let correct = false
    let verdict = ""
    if (r.text) {
      const j = await chat("judge", null, judgePrompt(item, r.text), 200)
      verdict = j.text
      correct = /^\s*yes/i.test(j.text)
    }
    results[i] = { question_id: item.question_id, type: item.type, session_hit: item.session_hit, correct, verdict, error: r.error ?? null, hypothesis: r.text.slice(0, 600) }
    console.error(`${i + 1}/${items.length} ${item.type} ${correct ? "Y" : "N"}${r.error ? " ERR " + r.error : ""}`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
const byType = {}
for (const r of results) {
  const s = (byType[r.type] ??= { n: 0, correct: 0, hit: 0, correct_given_hit: 0, errors: 0 })
  s.n += 1
  s.correct += r.correct ? 1 : 0
  s.hit += r.session_hit ? 1 : 0
  s.correct_given_hit += r.correct && r.session_hit ? 1 : 0
  s.errors += r.error ? 1 : 0
}
writeFileSync(process.argv[3], JSON.stringify({ model: MODEL_ID, usage, byType, results }, null, 1))
const total = Object.values(byType).reduce((a, s) => ({ n: a.n + s.n, correct: a.correct + s.correct, errors: a.errors + s.errors }), { n: 0, correct: 0, errors: 0 })
console.log(JSON.stringify({ model: MODEL_ID, usage, total, byType }))
