#!/usr/bin/env node
/**
 * ab-memory-experiment.mjs — 离线 A/B（仅实验用，不碰生产代码/部署）
 *
 * 实验 A：curator v1 vs v2（同一 transcript、同一模型，盲评四维）
 * 实验 B：种子记忆开 vs 关（生产 shared export + 生产 recallTop，盲评 0/1/2）
 *
 * 预算硬闸：模型呼叫 ≤80、输入 token ≤400k；超限立即停并按已完成样本出报告。
 * 密钥只在本进程内读取 agent-models.json / .env，绝不打印或落盘。
 *
 * 用法（VPS）：
 *   node --experimental-transform-types /tmp/ab-memory-experiment.mjs --dry-run
 *   node --experimental-transform-types /tmp/ab-memory-experiment.mjs
 */
import { execFileSync } from "node:child_process"
import { createHash, createHmac } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const DB_PATH = "/opt/agent-harness/workspace/.local/share/opencode/opencode.db"
const MODELS_PATH = "/opt/agent-harness/agent-models.json"
const ENV_PATH = "/opt/agent-harness/.env"
const RECALL_MODULE = "/opt/agent-harness/gateway/memory-recall.ts"
const REPORT_JSON = "/tmp/ab-memory-report.json"
const REPORT_MD = "/tmp/ab-memory-report.md"
const MODEL_ID = "deepseek-v4.1-flash"
const DRY_RUN = process.argv.includes("--dry-run")

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}
const ARG_EXP = argValue("--exp") // "a" = 只跑实验 A
const ARG_PAIR = argValue("--pair") || "v1v2"
const ARG_MAX_CALLS = Number(argValue("--max-calls"))
const ARG_SESSION_HASHES = String(argValue("--session-hashes") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

const BUDGET = { maxCalls: 80, maxInputTokens: 400_000 }
if (Number.isFinite(ARG_MAX_CALLS) && ARG_MAX_CALLS > 0) BUDGET.maxCalls = Math.min(BUDGET.maxCalls, ARG_MAX_CALLS)
// 用户指定：v1 vs v3 单跑预算 ≤35 次呼叫（10 会话 × 3 呼叫 = 30，余量给重试）。
if (ARG_EXP === "a" && ARG_PAIR === "v1v3" && !(Number.isFinite(ARG_MAX_CALLS) && ARG_MAX_CALLS > 0)) {
  BUDGET.maxCalls = 35
}
const TRANSCRIPT_CAP = 12_000
const TRANSCRIPT_MSG_WINDOW = 120
const EVAL_TRANSCRIPT_CAP = 2_000
const CANDIDATE_BODY_CAP = 1_200
const RECALL_BODY_CAP = 1_200
const SESSION_LIMIT = 10
const DAY_MS = 24 * 60 * 60 * 1000

// ─────────────────────────── 逐字 prompt（v1 = 4ea47695^，v2 = HEAD）

const CURATOR_PROMPT_V1 = `You are the memory curator for an AI image/video generation assistant.
Input: one conversation transcript. Output: a single JSON object. Nothing else.

You may propose memories of two scopes:
- "private": facts about THIS user that help future sessions serve them (preferences, specs, recurring corrections, working habits). Only these may be private.
- "shared": transferable DOMAIN KNOWLEDGE that any user of this product could benefit from - narrative structures, visual styles, cultural context, prompt techniques, industry conventions, domain facts learned from tool results. It MUST NOT contain anything identifying this user or this conversation.

HARD RULES - a proposal violating any of these is discarded downstream by the system:
- Every proposal MUST cite external evidence: a tool result, an explicit user confirmation, or a verbatim quote. Your own reasoning, inference, or pre-existing general knowledge is NOT evidence. If a statement is supported only by what you already knew, do not propose it.
- "shared" proposals MUST NOT contain: user names, account ids, session ids, emails, URLs, file paths, prices, API keys, tokens, or any detail traceable to one user or one purchase.
- Skip greetings, one-off requests, small talk, and anything derivable from the product itself (pricing tables, model lists, UI text).
- Do not propose anything you cannot state in one sentence.

Output schema (JSON only, no markdown fence):
{"session_id":"<id>","candidates":[{"scope":"private|shared","domain":"<one-level domain>","slug":"<kebab-case>","description":"<one line, <=120 chars>","type":"user|feedback|project|domain|workflow","body":"<=2000 chars; for feedback/project include **Why:** and **How to apply:**","links":["<other-slug>"],"evidence":"<verbatim quote of the tool result or the user's words, <=200 chars>","evidence_kind":"tool_result|user_confirmed|verbatim","self_score":1-5,"self_score_reason":"<one line>"}],"rejected":[{"note":"<what you skipped>","reason":"one_off|greeting|derivable|no_evidence|sensitive"}]}`

const CURATOR_PROMPT_V2 = `You are the memory curator for an AI image/video generation assistant.
Input: one conversation transcript. Output: a single JSON object. Nothing else.

You may propose memories of two scopes:
- "private": facts about THIS user that help future sessions serve them (preferences, specs, recurring corrections, working habits). Only these may be private.
- "shared": transferable DOMAIN KNOWLEDGE that any user of this product could benefit from - narrative structures, visual styles, cultural context, prompt techniques, industry conventions, domain facts learned from tool results. It MUST NOT contain anything identifying this user or this conversation.

HARD RULES - a proposal violating any of these is discarded downstream by the system:
- Every proposal MUST cite external evidence: a tool result, an explicit user confirmation, or a verbatim quote. Your own reasoning, inference, or pre-existing general knowledge is NOT evidence. If a statement is supported only by what you already knew, do not propose it.
- "shared" proposals MUST NOT contain: user names, account ids, session ids, emails, URLs, file paths, prices, API keys, tokens, or any detail traceable to one user or one purchase.
- Skip greetings, one-off requests, small talk, and anything derivable from the product itself (pricing tables, model lists, UI text).
- Do not propose anything you cannot state in one sentence.
- Write ONLY transferable long-term knowledge. Do NOT write the specific answer to this task, the output spec of this one request, or details of a single incident. For type="feedback", the body MUST state the cue (what signal triggered the correction), **Why:**, and **How to apply:**.
- For failure/correction candidates, evidence MUST quote the failing tool result or the user's own words. If you only have reasoning and no evidence, do not propose it.
- If the same knowledge already exists, do not propose it again in different words (the system deduplicates).

Output schema (JSON only, no markdown fence):
{"session_id":"<id>","candidates":[{"scope":"private|shared","domain":"<one-level domain>","slug":"<kebab-case>","description":"<one line, <=120 chars>","type":"user|feedback|project|domain|workflow","body":"<=2000 chars; for feedback/project include **Why:** and **How to apply:**","links":["<other-slug>"],"evidence":"<verbatim quote of the tool result or the user's words, <=200 chars>","evidence_kind":"tool_result|user_confirmed|verbatim","self_score":1-5,"self_score_reason":"<one line>"}],"rejected":[{"note":"<what you skipped>","reason":"one_off|greeting|derivable|no_evidence|sensitive"}]}`

// v3 = v1 原文只加一行，其余一字不动（由 v1 原文 insert 生成，避免漂移）。
const CURATOR_PROMPT_V3 = CURATOR_PROMPT_V1.replace(
  "- Do not propose anything you cannot state in one sentence.",
  "- Do not propose anything you cannot state in one sentence.\n- Write ONLY transferable long-term knowledge. Do NOT store the specific answer to this task, this request's output spec, or details of a single incident; those are wrong anchors for the next task.",
)

const EVAL_A_SYSTEM = `You are an independent evaluator of two memory-curation outputs produced from the SAME conversation transcript.
Each side is a JSON list of proposed memory candidates. Judge each side on four dimensions, integer 1-5:
1. transferability: useful to a DIFFERENT user/project (5 = broadly transferable, 1 = one-user-only).
2. evidence: claims are backed by quoted tool results or the user's own words (5 = strong verbatim evidence, 1 = no evidence).
3. executability: the body gives actionable cue/why/how that a future agent can apply (5 = concrete and actionable, 1 = vague).
4. task_specificity_penalty: how specific the output is to this one task/incident/answer (1 = generic transferable knowledge, 5 = one-off task answer). LOWER IS BETTER.
Also decide winner: "A", "B", or "tie". Weigh transferability, evidence, executability first; among otherwise-equal sides prefer the lower task_specificity_penalty.
Output JSON only, no markdown fence:
{"A":{"transferability":n,"evidence":n,"executability":n,"task_specificity_penalty":n},"B":{"transferability":n,"evidence":n,"executability":n,"task_specificity_penalty":n},"winner":"A|B|tie","reason":"<=120 chars"}`

const EVAL_B_SYSTEM = `You are an independent grader for memory-augmented question answering.
You receive a question, a reference answer, and two candidate answers (A and B) in random order.
Score EACH candidate against the reference answer on this scale:
0 = wrong, unsupported, or fabricated (includes inventing facts not in the reference);
1 = partially correct (some correct facts but missing key detail, or minor unsupported addition);
2 = correct and includes concrete actionable detail consistent with the reference.
Do not reward verbosity. Do not penalize wording differences. Decide winner: "A", "B", or "tie".
Output JSON only, no markdown fence:
{"A":0|1|2,"B":0|1|2,"winner":"A|B|tie","reason":"<=120 chars"}`

// ─────────────────────────── 实验 B 题库（12 条；问题只能由对应 note 回答）

const SEED_CASES = [
  {
    slug: "canvas-snapshot-needs-rev",
    domain: "canvas-workflow",
    question: "画布快照保存时，为什么旧标签页一保存就把新内容整份覆盖了？要怎么防止？",
    reference:
      "快照上行只带节点/连线、没有版本字段，服务端只校验大小，迟到的旧快照就会整份覆盖。做法：成功回执返回 rev；上行带 rev/version，小于当前值回 409 且不改已存快照；校验顶层为普通对象、节点/连线类型正确并拒绝 __proto__；形状校验要匹配真实前端；前端必须真正回传 rev，否则乐观锁无效。",
  },
  {
    slug: "cancel-does-not-stop-upstream-billing",
    domain: "billing",
    question: "任务点了取消，为什么上游后来还扣费？取消到底要做到哪几件事？",
    reference:
      "「已取消」要拆成三件：run 停了、job 停了、钱退了。停子代理 run 不等于停上游计费。取消要有提交顺序保证（先阻断再提交）；取消接口必须覆盖 job 层并支持退款/冲正；对账以平台账本为准；评测按时间戳而非对话顺序判先后；没有退款端点就如实说明，不承诺可退；对不存在的 id 返回 not_found，且不等于已取消。",
  },
  {
    slug: "skipped-budget-card-is-not-consent",
    domain: "billing",
    question: "预算确认卡被用户的新消息顶掉了，代理可以当成用户同意付费吗？",
    reference:
      "不可以。问卡被新消息跳过不等于同意；授权必须显式同意，并绑定模型、金额、数量与次数。只有显式同意文本才算授权；问卡被跳过时只能出报价或标「付费待授权」；派发前回溯问卡是否真的被回答，而不是看 agent 自述「已有授权内」；判据是「有没有发起付费请求」，不是「有没有扣到钱」。",
  },
  {
    slug: "subagent-dispatch-timeout-resource-thrash",
    domain: "agent-orchestration",
    question: "子代理一直报任务投递超时或 502，是不是网关投递逻辑坏了？",
    reference:
      "常见根因是运行容器内存顶满进入 D 态并 swap thrash，不是投递逻辑本身。先看 cgroup 的 memory.current（不是进程自身 rss）、swap 与磁盘占用；清理过期会话与评测产物；提高内存上限并给少量 swap；降低 ffmpeg 等子进程并发；确认 create 毫秒级、prompt_async 返回 204 后再查业务。只把超时从 10 秒调到 30 秒而内存上限仍 1500M 且零 swap，会直接 OOM。",
  },
  {
    slug: "recover-background-subagent-results",
    domain: "agent-orchestration",
    question: "后台子代理查不到结果，metadata 又显示 running，怎么判断它到底有没有完成？",
    reference:
      "后台子代理结果优先从完成通知的 result 字段取；查询必须用完整 id，短前缀会 No task found；metadata 的 running 可能已陈旧。按顺序查完成通知 result → output 文件 → metadata；用执行记录最后一条的完成时间判断死活；执行记录通常只有模型输入输出、没有工具回执，不能用来重建证据；确认丢了就带更精确 spec 重派，不要内联接管。",
  },
  {
    slug: "tools-map-unlisted-means-enabled",
    domain: "tool-behavior",
    question: "opencode 的 agent tools map 里没列出的工具，默认是关还是开？",
    reference:
      "默认是开。tools map 的语义是只写 false 项，未列＝默认开，不是白名单。要按角色收紧必须显式写 false；新增工具默认对全部席位开放，必须主动检查是否该全开；区分宣告面配置与运行期物理配置，以运行期为准；不要把 =true 当启用开关来验证，那只是声明性冗余。",
  },
  {
    slug: "long-commands-15s-background",
    domain: "tool-behavior",
    question: "终端命令一直卡在运行中，是不是该把超时调到 600 秒？",
    reference:
      "不该。运行时已有 15 秒预算，到点自动转后台并在结束后唤醒会话；调大超时只是把卡死藏起来。先查命令是否走了 wrapper、有没有后台产物、相关环境变量是否注入；以 sleep 开头的命令按设计豁免转后台，但仍受零输出判死约束；新加超时只能当兜底，不能替代 15 秒预算；验证走平台自己的派工端点。",
  },
  {
    slug: "model-listing-is-not-liveness",
    domain: "generation-platform",
    question: "/models 接口返回 200 且清单里有模型，就能判定它可调用吗？",
    reference:
      "不能。判活必须同时满足「清单里确实有该模型」与「近 24 小时有真实交付」。探测时校验模型 id 在清单内；加「近 24 小时有单但 0 交付 ⇒ 降为不可用」的真实结果闸；把不可用原因写进结果；报价与 UI 只用 proven 模型；区分供应商级冷却与单模型故障。只看端点 200 会把已下架模型继续报 available。",
  },
  {
    slug: "client-timeout-shorter-than-generation",
    domain: "generation-platform",
    question: "探针显示模型 ready，但生成总是 timeout，是不是上游不可用？",
    reference:
      "不一定。客户端超时短于真实生成耗时会系统性丢掉最强通道并留下孤儿任务；客户端报错不等于生成失败。应按实测耗时设超时；失败先按输入特征（风格、歌词、seed）匹配服务端产物目录，能收就收；探针 ready 要与「能否在超时内交付」对齐；无头评测不要长期保留会话；停损先用可逆方式冻结服务再杀 worker，不要动生产隧道。",
  },
  {
    slug: "reference-images-are-not-frame-locks",
    domain: "video-generation",
    question: "视频通道支持上传参考图，是不是就等于能锁定首帧和尾帧？",
    reference:
      "不等于。图片驱动参考（最多 N 张）不等于首帧/尾帧硬锁，不要因此截断分镜或把多张参考当连续帧。区分 reference_images 与 first_frame_url/last_frame_url；按镜分组引用关键帧，超上限显式拒绝而不是静默截断；聚合顺序 first→last→references，保留相同 URL 的首尾位置；只改提示词不够，必须同时修 API 吞参考图与工具硬拒。",
  },
  {
    slug: "no-delete-promise-for-generated-takes",
    domain: "media-qc",
    question: "用户说删掉多余的音频版本，能不能直接答应帮他删？",
    reference:
      "平台存储没有删除已生成音频的端点时不能承诺删除，只能说「不采用、不作为交付」。先分清对象：画布节点可删、平台存储的音频不可删；答之前扫描端点/工具确认能力；只说那一版不采用、不进交付清单；若用户指的是画布节点，先确认真实对象再删；多 take 不是版本参数，不能用「版本数」话术解释。",
  },
  {
    slug: "cors-cache-poisoning-download",
    domain: "image-generation",
    question: "图片在页面能显示，但下载时报缺少 ACAO，服务端响应头明明是对的，怎么回事？",
    reference:
      "资源带 immutable 长缓存、又按 Origin 动态给 CORS 头时，浏览器可能复用先以 no-cors 载入的无 ACAO 副本；服务端响应头全对仍会报缺少 ACAO。先带 Origin 用 curl 验证响应头；头正确就查缓存层（memory/disk/Service Worker）；下载 fetch 加 cache-buster 查询参数并设置 no-store；确认查询参数对服务端无副作用；修法要覆盖所有缓存层。",
  },
]

// ─────────────────────────── 基础工具

const sha8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8)
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null)
const round3 = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const stats = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  failedCalls: 0,
  retries: 0,
  budgetHit: false,
  errors: [],
}

function noteError(where, err) {
  const msg = err && err.message ? err.message : String(err)
  stats.errors.push({ where, message: msg.slice(0, 300) })
  console.error(`[error] ${where}: ${msg.slice(0, 200)}`)
}

function readEnv(path) {
  const out = {}
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

function loadModelChannel() {
  const j = JSON.parse(readFileSync(MODELS_PATH, "utf8"))
  const opt = j && j.providers && j.providers.happycoding && j.providers.happycoding.options
  if (!opt || !opt.baseURL || !opt.apiKey) throw new Error("happycoding channel missing baseURL/apiKey")
  return { baseURL: opt.baseURL.replace(/\/$/, ""), apiKey: opt.apiKey }
}

function sqlJson(sql) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const out = execFileSync("sudo", ["-n", "sqlite3", "-json", DB_PATH, sql], {
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        timeout: 120_000,
      })
      const t = out.trim()
      return t ? JSON.parse(t) : []
    } catch (e) {
      lastErr = e
      if (attempt === 0) {
        stats.retries += 1
        sleepSync(500)
      }
    }
  }
  throw lastErr
}

function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buf, 0, 0, ms)
}

function sqlQuote(s) {
  return String(s).replace(/'/g, "''")
}

function stripFence(text) {
  let t = String(text ?? "").trim()
  t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim()
  return t
}

function parseJsonLoose(text) {
  const t = stripFence(text)
  try {
    return JSON.parse(t)
  } catch {}
  const first = t.indexOf("{")
  const last = t.lastIndexOf("}")
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1))
    } catch {}
  }
  throw new Error("json_parse_failed")
}

// ─────────────────────────── 模型通道（预算硬闸 + 失败只重试 1 次）

function budgetExhausted() {
  return stats.calls >= BUDGET.maxCalls || stats.inputTokens >= BUDGET.maxInputTokens
}

class BudgetError extends Error {}

async function callModelRaw({ system, user, maxTokens, temperature = 0 }) {
  if (budgetExhausted()) {
    stats.budgetHit = true
    throw new BudgetError("budget_exhausted")
  }
  const channel = loadModelChannel()
  stats.calls += 1
  const messages = []
  if (system) messages.push({ role: "system", content: system })
  messages.push({ role: "user", content: user })
  const res = await fetch(`${channel.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${channel.apiKey}` },
    body: JSON.stringify({ model: MODEL_ID, temperature, max_tokens: maxTokens, messages }),
  })
  const raw = await res.text()
  if (!res.ok) throw new Error(`http_${res.status}`)
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    throw new Error("response_not_json")
  }
  const choice = j.choices && j.choices[0]
  const content = choice && choice.message ? choice.message.content : ""
  if (!String(content ?? "").trim()) {
    throw new Error(`empty_content(finish=${choice && choice.finish_reason},refusal=${!!(choice && choice.message && choice.message.refusal)})`)
  }
  const usage = j.usage || {}
  const promptTokens = Number.isFinite(usage.prompt_tokens)
    ? usage.prompt_tokens
    : Math.ceil((system || "").length / 4) + Math.ceil(user.length / 4)
  const completionTokens = Number.isFinite(usage.completion_tokens)
    ? usage.completion_tokens
    : Math.ceil(String(content).length / 4)
  stats.inputTokens += promptTokens
  stats.outputTokens += completionTokens
  return String(content ?? "")
}

async function callModel(args) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await callModelRaw(args)
    } catch (e) {
      if (e instanceof BudgetError) throw e
      lastErr = e
      if (attempt === 0) {
        stats.retries += 1
        await sleep(800)
      }
    }
  }
  stats.failedCalls += 1
  lastErr.__callFailed = true
  throw lastErr
}

/** 取 JSON：请求失败/解析失败各只重试 1 次。 */
async function callJson(args, where) {
  let lastErr
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const text = await callModel(args)
      return parseJsonLoose(text)
    } catch (e) {
      if (e instanceof BudgetError) throw e
      lastErr = e
      if (attempt === 0) {
        stats.retries += 1
        await sleep(500)
      }
    }
  }
  if (!lastErr.__callFailed) stats.failedCalls += 1
  noteError(where, lastErr)
  return null
}

/** 预算中止用：BudgetError 不当作失败，回传 {budget:true}。 */
async function safeJson(args, where) {
  try {
    return { value: await callJson(args, where), budget: false }
  } catch (e) {
    if (e instanceof BudgetError) return { value: null, budget: true }
    throw e
  }
}

async function safeModel(args, where) {
  try {
    return { value: await callModel(args), budget: false }
  } catch (e) {
    if (e instanceof BudgetError) return { value: null, budget: true }
    noteError(where, e)
    return { value: null, budget: false }
  }
}

function shuffleSwap() {
  return Math.random() < 0.5
}

// ─────────────────────────── 实验 A：会话选择与 transcript

function selectSessions() {
  const since = Date.now() - 14 * DAY_MS
  // 指定 --session-hashes 时放宽抓取窗口，再按哈希过滤，保证复跑命中同一批会话。
  const limit = ARG_SESSION_HASHES.length ? 50 : SESSION_LIMIT
  const sql = `
    SELECT s.id AS id, s.time_updated AS time_updated,
           COUNT(DISTINCT m.id) AS messages,
           SUM(CASE WHEN json_extract(m.data,'$.role')='user' THEN 1 ELSE 0 END) AS user_messages
    FROM session s JOIN message m ON m.session_id = s.id
    WHERE s.parent_id IS NULL
      AND s.time_updated >= ${Math.floor(since)}
    GROUP BY s.id
    HAVING user_messages >= 3
    ORDER BY s.time_updated DESC
    LIMIT ${limit}`
  const rows = sqlJson(sql)
  if (!ARG_SESSION_HASHES.length) return rows
  const byHash = new Map(rows.map((r) => [sha8(r.id), r]))
  return ARG_SESSION_HASHES.map((h) => byHash.get(h)).filter(Boolean)
}

function buildTranscript(sessionId) {
  const sid = sqlQuote(sessionId)
  const sql = `
    SELECT m.id AS mid,
           json_extract(m.data,'$.role') AS role,
           json_extract(p.data,'$.type') AS type,
           substr(json_extract(p.data,'$.text'),1,4000) AS text,
           json_extract(p.data,'$.tool') AS tool,
           json_extract(p.data,'$.state.status') AS status
    FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = '${sid}'
      AND m.id IN (SELECT id FROM message WHERE session_id = '${sid}' ORDER BY time_created DESC LIMIT ${TRANSCRIPT_MSG_WINDOW})
      AND json_extract(p.data,'$.type') IN ('text','tool')
    ORDER BY m.time_created ASC, m.id ASC, p.time_created ASC, p.id ASC`
  const rows = sqlJson(sql)

  let out = ""
  let currentMsg = null
  let currentRole = null
  const push = (s) => {
    if (!s) return
    if (out.length >= TRANSCRIPT_CAP) return
    const remain = TRANSCRIPT_CAP - out.length
    out += s.length > remain ? s.slice(0, remain) : s
  }

  for (const r of rows) {
    if (out.length >= TRANSCRIPT_CAP) break
    if (r.mid !== currentMsg) {
      currentMsg = r.mid
      currentRole = r.role
      push(`\n${r.role === "user" ? "USER" : "ASSISTANT"}: `)
    }
    if (r.role === "user") {
      if (r.type === "text" && r.text) push(`${r.text}\n`)
    } else if (r.role === "assistant") {
      if (r.type === "text" && r.text) push(`${r.text}\n`)
      if (r.type === "tool") {
        push(`[tool: ${r.tool || "unknown"} | ${r.status || "unknown"}]\n`)
      }
    }
  }
  return out.trim()
}

function usableCandidates(parsed) {
  if (!parsed || !Array.isArray(parsed.candidates)) return []
  return parsed.candidates.filter((c) => {
    if (!c || typeof c !== "object") return false
    return typeof c.description === "string" && c.description.trim() !== "" &&
      typeof c.body === "string" && c.body.trim() !== ""
  })
}

function candidateDigest(cands) {
  return cands.slice(0, 8).map((c) => ({
    scope: c.scope,
    domain: c.domain,
    type: c.type,
    slug: c.slug,
    description: String(c.description ?? "").slice(0, 300),
    body: String(c.body ?? "").slice(0, CANDIDATE_BODY_CAP),
    evidence: String(c.evidence ?? "").slice(0, 300),
  }))
}

function scoreDimensions(obj) {
  const dims = ["transferability", "evidence", "executability", "task_specificity_penalty"]
  const out = {}
  for (const d of dims) {
    const v = Number(obj && obj[d])
    out[d] = Number.isFinite(v) ? Math.max(1, Math.min(5, v)) : null
  }
  return out
}

const PAIR_V1V2 = { leftLabel: "v1", rightLabel: "v2", left: CURATOR_PROMPT_V1, right: CURATOR_PROMPT_V2 }
const PAIR_V1V3 = { leftLabel: "v1", rightLabel: "v3", left: CURATOR_PROMPT_V1, right: CURATOR_PROMPT_V3 }

function pairForArgs() {
  return ARG_PAIR === "v1v3" ? PAIR_V1V3 : PAIR_V1V2
}

async function runExperimentA(pair = PAIR_V1V2) {
  console.log(`[A] selecting sessions ... pair=${pair.leftLabel}_vs_${pair.rightLabel}`)
  const sessions = selectSessions()
  const samples = []

  for (let i = 0; i < sessions.length; i += 1) {
    if (budgetExhausted()) break
    const s = sessions[i]
    const id8 = sha8(s.id)
    console.log(`[A ${i + 1}/${sessions.length}] session=${id8} users=${s.user_messages}`)
    let transcript = ""
    try {
      transcript = buildTranscript(s.id)
    } catch (e) {
      noteError(`A.transcript.${id8}`, e)
      samples.push({ session: id8, user_messages: s.user_messages, error: "transcript_failed" })
      continue
    }
    if (!transcript) {
      samples.push({ session: id8, user_messages: s.user_messages, error: "empty_transcript" })
      continue
    }

    const mkPrompt = (p) => `${p}\n\n<transcript>\n${transcript}\n</transcript>`
    const r1 = await safeJson(
      { system: null, user: mkPrompt(pair.left), maxTokens: 8000 },
      `A.${pair.leftLabel}.${id8}`,
    )
    if (r1.budget) {
      samples.push({ session: id8, user_messages: s.user_messages, error: "budget_skipped" })
      break
    }
    const r2 = await safeJson(
      { system: null, user: mkPrompt(pair.right), maxTokens: 8000 },
      `A.${pair.rightLabel}.${id8}`,
    )
    if (r2.budget) {
      samples.push({ session: id8, user_messages: s.user_messages, error: "budget_skipped" })
      break
    }
    const v1Parsed = r1.value
    const v2Parsed = r2.value
    const rec = {
      session: id8,
      user_messages: s.user_messages,
      transcript_chars: transcript.length,
      v1_parse_ok: !!v1Parsed,
      v2_parse_ok: !!v2Parsed,
      v1_usable: usableCandidates(v1Parsed).length,
      v2_usable: usableCandidates(v2Parsed).length,
      v1_candidates: 0,
      v2_candidates: 0,
      eval: null,
    }
    if (v1Parsed && Array.isArray(v1Parsed.candidates)) rec.v1_candidates = v1Parsed.candidates.length
    if (v2Parsed && Array.isArray(v2Parsed.candidates)) rec.v2_candidates = v2Parsed.candidates.length

    if (v1Parsed && v2Parsed && !budgetExhausted()) {
      const swap = shuffleSwap()
      const aCands = swap ? candidateDigest(usableCandidates(v2Parsed)) : candidateDigest(usableCandidates(v1Parsed))
      const bCands = swap ? candidateDigest(usableCandidates(v1Parsed)) : candidateDigest(usableCandidates(v2Parsed))
      const excerpt = transcript.slice(0, EVAL_TRANSCRIPT_CAP)
      const user = [
        "<transcript_excerpt>",
        excerpt,
        "</transcript_excerpt>",
        "<candidates_a>",
        JSON.stringify(aCands),
        "</candidates_a>",
        "<candidates_b>",
        JSON.stringify(bCands),
        "</candidates_b>",
        "Score both sides and output the JSON object.",
      ].join("\n")
      const evRes = await safeJson({ system: EVAL_A_SYSTEM, user, maxTokens: 2500 }, `A.eval.${id8}`)
      if (evRes.budget) {
        samples.push(rec)
        break
      }
      const ev = evRes.value
      if (ev && ev.A && ev.B) {
        const a = scoreDimensions(ev.A)
        const b = scoreDimensions(ev.B)
        const winner = ev.winner === "A" ? (swap ? "v2" : "v1") : ev.winner === "B" ? (swap ? "v1" : "v2") : "tie"
        rec.eval = {
          order: swap
            ? `A=${pair.rightLabel},B=${pair.leftLabel}`
            : `A=${pair.leftLabel},B=${pair.rightLabel}`,
          v1: swap ? b : a,
          v2: swap ? a : b,
          winner,
        }
        rec.eval.reason = String(ev.reason ?? "").slice(0, 120)
      }
    }
    samples.push(rec)
  }

  return {
    selected: sessions.length,
    samples,
    metrics: aggregateA(samples),
    labels: { left: pair.leftLabel, right: pair.rightLabel },
  }
}

const A_DIMS = ["transferability", "evidence", "executability", "task_specificity_penalty"]

function aggregateA(samples) {
  const rows = samples.filter((s) => s.eval)
  const avg = (side, dim) => {
    const vals = rows.map((r) => r.eval[side][dim]).filter((v) => Number.isFinite(v))
    return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null
  }
  const v1 = {}
  const v2 = {}
  const delta = {}
  for (const d of A_DIMS) {
    v1[d] = avg("v1", d)
    v2[d] = avg("v2", d)
    delta[d] = v1[d] !== null && v2[d] !== null ? round2(v2[d] - v1[d]) : null
  }
  const wins = { v1: 0, v2: 0, tie: 0 }
  for (const r of rows) wins[r.eval.winner] += 1
  const v1Usable = samples.reduce((a, s) => a + (s.v1_usable || 0), 0)
  const v2Usable = samples.reduce((a, s) => a + (s.v2_usable || 0), 0)
  return {
    evaluated: rows.length,
    v1,
    v2,
    delta,
    specificity_drop: v1.task_specificity_penalty !== null && v2.task_specificity_penalty !== null
      ? round2(v1.task_specificity_penalty - v2.task_specificity_penalty)
      : null,
    wins,
    usable: {
      v1_total: v1Usable,
      v2_total: v2Usable,
      v1_mean: samples.length ? round2(v1Usable / samples.length) : null,
      v2_mean: samples.length ? round2(v2Usable / samples.length) : null,
    },
  }
}

// ─────────────────────────── 实验 B：生产 export + recallTop

async function fetchSharedCorpus(env) {
  const base = env.MEMORY_INGEST_BASE_URL
  const secret = env.MEMORY_INGEST_SECRET
  if (!base || !secret) throw new Error("MEMORY_INGEST_BASE_URL/SECRET missing")
  const sig = "sha256=" + createHmac("sha256", secret).update(Buffer.alloc(0)).digest("hex")
  const url = `${base.replace(/\/$/, "")}/api/agent/memory/export?scope=shared`
  let lastErr
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "x-memory-signature": sig } })
      if (!res.ok) throw new Error(`export_http_${res.status}`)
      const j = await res.json()
      if (!Array.isArray(j.docs)) throw new Error("export_shape_invalid")
      return j.docs
        .filter((d) => d && typeof d.domain === "string" && typeof d.slug === "string" &&
          typeof d.description === "string" && typeof d.body === "string")
        .map((d) => ({
          domain: d.domain,
          slug: d.slug,
          description: d.description,
          body: d.body,
          updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : typeof d.createdAt === "string" ? d.createdAt : undefined,
        }))
    } catch (e) {
      lastErr = e
      if (attempt === 0) {
        stats.retries += 1
        await sleep(800)
      }
    }
  }
  throw lastErr
}

async function loadRecallTop() {
  const mod = await import(RECALL_MODULE)
  if (typeof mod.recallTop !== "function") throw new Error("recallTop_not_exported")
  return mod.recallTop
}

function buildSeedSystem(referenceBlock) {
  const base = "You are a helpful assistant for an AI image/video generation product. 回答简洁、直接，给出可执行的细节。优先依据资料回答；资料不足就明确说不足，不要编造。"
  if (!referenceBlock) return base
  return `${base}\n\n<reference_materials>\n${referenceBlock}\n</reference_materials>`
}

async function runExperimentB() {
  const env = readEnv(ENV_PATH)
  console.log("[B] fetching shared corpus ...")
  const docs = await fetchSharedCorpus(env)
  const recallTop = await loadRecallTop()
  console.log(`[B] corpus docs=${docs.length}; questions=${SEED_CASES.length}`)
  const items = []

  for (let i = 0; i < SEED_CASES.length; i += 1) {
    if (budgetExhausted()) break
    const c = SEED_CASES[i]
    console.log(`[B ${i + 1}/${SEED_CASES.length}] ${c.slug}`)
    let hits = []
    try {
      hits = recallTop(c.question, docs, { k: 3 })
    } catch (e) {
      noteError(`B.recall.${c.slug}`, e)
    }
    const targetHit = hits.some((h) => h.doc && h.doc.slug === c.slug)
    const block = hits.length
      ? hits
          .map((h, idx) => `[${idx + 1}] ${h.doc.domain}/${h.doc.slug} (score ${round2(h.score)})\n${h.doc.body.slice(0, RECALL_BODY_CAP)}`)
          .join("\n\n")
      : ""

    const onRes = await safeModel(
      { system: buildSeedSystem(block), user: c.question, maxTokens: 2500 },
      `B.on.${c.slug}`,
    )
    if (onRes.budget) break
    const offRes = await safeModel(
      { system: buildSeedSystem(""), user: c.question, maxTokens: 2500 },
      `B.off.${c.slug}`,
    )
    if (offRes.budget) break
    const onText = onRes.value
    const offText = offRes.value

    const rec = {
      slug: c.slug,
      domain: c.domain,
      recall_hits: hits.length,
      recall_target_hit: targetHit,
      recall_top_slug: hits.length && hits[0].doc ? hits[0].doc.slug : null,
      on_ok: onText !== null,
      off_ok: offText !== null,
      on_chars: onText ? onText.length : 0,
      off_chars: offText ? offText.length : 0,
      eval: null,
    }

    if (onText !== null && offText !== null && !budgetExhausted()) {
      const swap = shuffleSwap()
      const aText = swap ? offText : onText
      const bText = swap ? onText : offText
      const user = [
        "<question>",
        c.question,
        "</question>",
        "<reference_answer>",
        c.reference,
        "</reference_answer>",
        "<answer_a>",
        aText.slice(0, 3000),
        "</answer_a>",
        "<answer_b>",
        bText.slice(0, 3000),
        "</answer_b>",
        "Score both candidates and output the JSON object.",
      ].join("\n")
      const evRes = await safeJson({ system: EVAL_B_SYSTEM, user, maxTokens: 1500 }, `B.eval.${c.slug}`)
      if (evRes.budget) {
        items.push(rec)
        break
      }
      const ev = evRes.value
      if (ev) {
        const aScore = Number(ev.A)
        const bScore = Number(ev.B)
        const clamp = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(2, Math.round(n))) : null)
        const as = clamp(aScore)
        const bs = clamp(bScore)
        const winner = ev.winner === "A" ? (swap ? "off" : "on") : ev.winner === "B" ? (swap ? "on" : "off") : "tie"
        rec.eval = {
          order: swap ? "A=off,B=on" : "A=on,B=off",
          on: swap ? bs : as,
          off: swap ? as : bs,
          winner,
        }
        rec.eval.reason = String(ev.reason ?? "").slice(0, 120)
      }
    }
    items.push(rec)
  }

  return { items, metrics: aggregateB(items) }
}

function aggregateB(items) {
  const rows = items.filter((x) => x.eval)
  const avg = (side) => {
    const vals = rows.map((r) => r.eval[side]).filter((v) => Number.isFinite(v))
    return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null
  }
  const wins = { on: 0, off: 0, tie: 0 }
  for (const r of rows) wins[r.eval.winner] += 1
  const zeroRate = (side) => {
    const vals = rows.map((r) => r.eval[side]).filter((v) => Number.isFinite(v))
    if (!vals.length) return null
    return round3(vals.filter((v) => v === 0).length / vals.length)
  }
  return {
    evaluated: rows.length,
    on_mean: avg("on"),
    off_mean: avg("off"),
    wins,
    hallucination_rate_on: zeroRate("on"),
    hallucination_rate_off: zeroRate("off"),
    recall_target_hit_rate: items.length
      ? round3(items.filter((x) => x.recall_target_hit).length / items.length)
      : null,
    recall_hit_counts: items.map((x) => x.recall_hits),
  }
}

// ─────────────────────────── 报告

function buildReport(a, b) {
  return {
    meta: {
      generated_at: new Date().toISOString(),
      model: MODEL_ID,
      dry_run: false,
      budget: BUDGET,
      calls_used: stats.calls,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      failed_calls: stats.failedCalls,
      retries: stats.retries,
      budget_hit: stats.budgetHit,
      errors: stats.errors,
      transcript_cap_chars: TRANSCRIPT_CAP,
      transcript_message_window: TRANSCRIPT_MSG_WINDOW,
      session_limit: SESSION_LIMIT,
      // 实验开跑前的两次外部预检（不在本脚本统计内，如实单列）
      external_preflight: {
        calls: 2,
        input_tokens_approx: 6450,
        note: "1 次通道冒烟 + 1 次解析诊断；均发生在正式实验前",
      },
    },
    experiment_a: a,
    experiment_b: b,
  }
}

function fmt(v) {
  return v === null || v === undefined ? "n/a" : String(v)
}

function buildMarkdown(report) {
  const { meta } = report
  const A = report.experiment_a
  const B = report.experiment_b
  const L = []
  L.push("# 记忆 A/B 离线实验报告")
  L.push("")
  L.push(`- 生成时间：${meta.generated_at}`)
  L.push(`- 模型：${meta.model}（temperature=0，happycoding 通道）`)
  L.push(`- 预算：呼叫 ${meta.calls_used}/${meta.budget.maxCalls}，输入 token ${meta.input_tokens}/${meta.budget.maxInputTokens}，输出 token ${meta.output_tokens}`)
  L.push(`- 失败呼叫：${meta.failed_calls}；重试：${meta.retries}；触发预算上限：${meta.budget_hit ? "是" : "否"}`)
  L.push(`- 实验前外部预检：${meta.external_preflight.calls} 次呼叫（约 ${meta.external_preflight.input_tokens_approx} 输入 token，未计入上列脚本统计；${meta.external_preflight.note}）`)
  L.push(`- 会话 transcript：最后 ${meta.transcript_message_window} 条消息、单会话上限 ${meta.transcript_cap_chars} 字符`)
  L.push("")
  L.push("## 实验 A：curator v1 vs v2")
  L.push("")
  L.push(`- 样本量：选中 ${A.selected ?? A.samples.length} 个会话，记录 ${A.samples.length} 个，完成盲评 ${A.metrics.evaluated} 个`)
  L.push(`- 可用条数（description 与 body 非空）：v1 共 ${A.metrics.usable.v1_total}（均 ${fmt(A.metrics.usable.v1_mean)}/会话），v2 共 ${A.metrics.usable.v2_total}（均 ${fmt(A.metrics.usable.v2_mean)}/会话）`)
  L.push(`- 胜/平/负（v1 视角）：v1 胜 ${A.metrics.wins.v1}，平 ${A.metrics.wins.tie}，v2 胜 ${A.metrics.wins.v2}`)
  L.push("")
  L.push("| 维度（1-5） | v1 | v2 | v2-v1 |")
  L.push("|---|---|---|---|")
  const labels = {
    transferability: "可迁移性",
    evidence: "证据充分",
    executability: "可执行性",
    task_specificity_penalty: "任务特异性惩罚（越低越好）",
  }
  for (const d of A_DIMS) {
    L.push(`| ${labels[d]} | ${fmt(A.metrics.v1[d])} | ${fmt(A.metrics.v2[d])} | ${fmt(A.metrics.delta[d])} |`)
  }
  L.push("")
  L.push(`- 任务特异性下降幅度（v1 - v2，正数=改善）：${fmt(A.metrics.specificity_drop)}`)
  L.push("")
  L.push("| 会话(sha8) | 用户消息 | v1 可用 | v2 可用 | 胜者 |")
  L.push("|---|---|---|---|---|")
  for (const s of A.samples) {
    L.push(`| ${s.session} | ${fmt(s.user_messages)} | ${fmt(s.v1_usable)} | ${fmt(s.v2_usable)} | ${s.eval ? s.eval.winner : "未评"} |`)
  }
  L.push("")
  L.push("## 实验 B：种子记忆 ON vs OFF")
  L.push("")
  L.push(`- 样本量：${B.items.length} 题，完成盲评 ${B.metrics.evaluated} 题`)
  L.push(`- 平均分（0/1/2）：ON ${fmt(B.metrics.on_mean)}，OFF ${fmt(B.metrics.off_mean)}`)
  L.push(`- 胜/平/负（ON 视角）：ON 胜 ${B.metrics.wins.on}，平 ${B.metrics.wins.tie}，OFF 胜 ${B.metrics.wins.off}`)
  L.push(`- 编造率（0 分比例）：ON ${fmt(B.metrics.hallucination_rate_on)}，OFF ${fmt(B.metrics.hallucination_rate_off)}`)
  L.push(`- 目标 note 进入 top-3 的比例：${fmt(B.metrics.recall_target_hit_rate)}`)
  L.push("")
  L.push("| note | 召回条数 | 命中目标 | ON | OFF | 胜者 |")
  L.push("|---|---|---|---|---|---|")
  for (const it of B.items) {
    L.push(`| ${it.slug} | ${it.recall_hits} | ${it.recall_target_hit ? "是" : "否"} | ${it.eval ? it.eval.on : "未评"} | ${it.eval ? it.eval.off : "未评"} | ${it.eval ? it.eval.winner : "未评"} |`)
  }
  L.push("")
  L.push("## 失败与偏差")
  L.push("")
  L.push(`- 是否触发预算上限：${meta.budget_hit ? "是（已按已完成样本出报告）" : "否"}`)
  L.push(`- 最终失败呼叫数：${meta.failed_calls}`)
  if (meta.errors.length === 0) {
    L.push("- 无错误。")
  } else {
    for (const e of meta.errors) L.push(`- ${e.where}: ${e.message}`)
  }
  L.push("")
  L.push("> 报告不含任何原始对话或用户内容；会话 id 只保留 sha256 前 8 位。")
  return L.join("\n")
}

// ─────────────────────────── 只跑实验 A 的报告（v1 vs v3）

function buildAReport(a, pair) {
  return {
    meta: {
      generated_at: new Date().toISOString(),
      model: MODEL_ID,
      pair: `${pair.leftLabel}_vs_${pair.rightLabel}`,
      dry_run: false,
      budget: BUDGET,
      calls_used: stats.calls,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      failed_calls: stats.failedCalls,
      retries: stats.retries,
      budget_hit: stats.budgetHit,
      errors: stats.errors,
      transcript_cap_chars: TRANSCRIPT_CAP,
      transcript_message_window: TRANSCRIPT_MSG_WINDOW,
      session_limit: SESSION_LIMIT,
      sessions_pinned: ARG_SESSION_HASHES.length > 0,
    },
    experiment_a: a,
  }
}

function buildMarkdownAOnly(report, pair) {
  const { meta } = report
  const A = report.experiment_a
  const L = pair.leftLabel
  const R = pair.rightLabel
  const lines = []
  lines.push(`# 记忆 A/B 离线实验报告（实验 A：${L} vs ${R}）`)
  lines.push("")
  lines.push(`- 生成时间：${meta.generated_at}`)
  lines.push(`- 模型：${meta.model}（temperature=0，happycoding 通道）`)
  lines.push(`- 配对：${L} vs ${R}；judge/rubric 与上一轮 v1 vs v2 完全相同`)
  lines.push(`- 预算：呼叫 ${meta.calls_used}/${meta.budget.maxCalls}，输入 token ${meta.input_tokens}/${meta.budget.maxInputTokens}，输出 token ${meta.output_tokens}`)
  lines.push(`- 失败呼叫：${meta.failed_calls}；重试：${meta.retries}；触发预算上限：${meta.budget_hit ? "是" : "否"}`)
  lines.push(`- 会话：${meta.sessions_pinned ? "按上一轮同一批会话哈希固定" : "按 14 天筛选"}（上限 ${meta.session_limit}）；transcript 最后 ${meta.transcript_message_window} 条消息、单会话上限 ${meta.transcript_cap_chars} 字符`)
  lines.push("")
  lines.push(`## 实验 A：curator ${L} vs ${R}`)
  lines.push("")
  lines.push(`- 样本量：选中 ${A.selected ?? A.samples.length} 个会话，记录 ${A.samples.length} 个，完成盲评 ${A.metrics.evaluated} 个`)
  lines.push(`- 可用条数（description 与 body 非空）：${L} 共 ${A.metrics.usable.v1_total}（均 ${fmt(A.metrics.usable.v1_mean)}/会话），${R} 共 ${A.metrics.usable.v2_total}（均 ${fmt(A.metrics.usable.v2_mean)}/会话）`)
  lines.push(`- 胜/平/负（${L} 视角）：${L} 胜 ${A.metrics.wins.v1}，平 ${A.metrics.wins.tie}，${R} 胜 ${A.metrics.wins.v2}`)
  lines.push("")
  lines.push("| 维度（1-5） | " + L + " | " + R + " | " + R + "-" + L + " |")
  lines.push("|---|---|---|---|")
  const labels = {
    transferability: "可迁移性",
    evidence: "证据充分",
    executability: "可执行性",
    task_specificity_penalty: "任务特异性惩罚（越低越好）",
  }
  for (const d of A_DIMS) {
    lines.push(`| ${labels[d]} | ${fmt(A.metrics.v1[d])} | ${fmt(A.metrics.v2[d])} | ${fmt(A.metrics.delta[d])} |`)
  }
  lines.push("")
  lines.push(`- 任务特异性下降幅度（${L} - ${R}，正数=改善）：${fmt(A.metrics.specificity_drop)}`)
  lines.push("")
  lines.push(`| 会话(sha8) | 用户消息 | ${L} 可用 | ${R} 可用 | 胜者 |`)
  lines.push("|---|---|---|---|---|")
  const winnerLabel = (w) => (w === "v1" ? L : w === "v2" ? R : w)
  for (const s of A.samples) {
    lines.push(`| ${s.session} | ${fmt(s.user_messages)} | ${fmt(s.v1_usable)} | ${fmt(s.v2_usable)} | ${s.eval ? winnerLabel(s.eval.winner) : "未评"} |`)
  }
  lines.push("")

  const three = ["transferability", "evidence", "executability"]
  const threePass = three.every((d) => Number.isFinite(A.metrics.delta[d]) && A.metrics.delta[d] >= -0.2)
  const specPass = Number.isFinite(A.metrics.specificity_drop) && A.metrics.specificity_drop > 0
  lines.push("## 判据结论")
  lines.push("")
  lines.push(`- 三项差值（${R}-${L}）：可迁移 ${fmt(A.metrics.delta.transferability)}，证据 ${fmt(A.metrics.delta.evidence)}，可执行 ${fmt(A.metrics.delta.executability)}；要求均 ≥ -0.2（容差 0.2）：${threePass ? "通过" : "不通过"}`)
  lines.push(`- 任务特异性惩罚：${L} ${fmt(A.metrics.v1.task_specificity_penalty)}，${R} ${fmt(A.metrics.v2.task_specificity_penalty)}；要求 ${R} 低于 ${L}：${specPass ? "通过" : "不通过"}`)
  lines.push(`- 结论：${threePass && specPass ? `建议采纳 ${R}` : `建议回滚到 ${L}`}`)
  lines.push("")
  lines.push("## 失败与偏差")
  lines.push("")
  lines.push(`- 是否触发预算上限：${meta.budget_hit ? "是（已按已完成样本出报告）" : "否"}`)
  lines.push(`- 最终失败呼叫数：${meta.failed_calls}`)
  if (meta.errors.length === 0) {
    lines.push("- 无错误。")
  } else {
    for (const e of meta.errors) lines.push(`- ${e.where}: ${e.message}`)
  }
  for (const s of A.samples) {
    if (s.error) lines.push(`- ${s.session}: ${s.error}`)
  }
  lines.push("")
  lines.push("> 报告不含任何原始对话或用户内容；会话 id 只保留 sha256 前 8 位。")
  return lines.join("\n")
}

// ─────────────────────────── 主流程

async function main() {
  const channel = loadModelChannel() // 只验证配置存在，不打印任何密钥
  void channel
  console.log(`mode=${DRY_RUN ? "dry-run" : "run"} budget_calls=${BUDGET.maxCalls} budget_input_tokens=${BUDGET.maxInputTokens}`)

  const aOnly = ARG_EXP === "a"

  if (DRY_RUN) {
    const sessions = selectSessions()
    let transcriptChars = 0
    for (const s of sessions) {
      try {
        transcriptChars += buildTranscript(s.id).length
      } catch (e) {
        noteError(`dryrun.transcript.${sha8(s.id)}`, e)
      }
    }
    let docs = []
    if (!aOnly) {
      try {
        docs = await fetchSharedCorpus(readEnv(ENV_PATH))
      } catch (e) {
        noteError("dryrun.export", e)
      }
    }
    const plannedCalls = sessions.length * 3 + (aOnly ? 0 : SEED_CASES.length * 3)
    console.log(JSON.stringify({
      dry_run: true,
      exp: aOnly ? "a" : "a+b",
      pair: ARG_PAIR,
      sessions: sessions.length,
      session_hashes: sessions.map((s) => sha8(s.id)),
      questions: aOnly ? 0 : SEED_CASES.length,
      planned_calls: plannedCalls,
      corpus_docs: docs.length,
      transcript_chars_total: transcriptChars,
      budget: BUDGET,
      errors: stats.errors,
    }, null, 2))
    return
  }

  if (aOnly) {
    const pair = pairForArgs()
    const a = await runExperimentA(pair)
    const report = buildAReport(a, pair)
    const base = ARG_PAIR === "v1v3" ? "/tmp/ab-memory-v1v3" : `/tmp/ab-memory-a-${ARG_PAIR}`
    writeFileSync(`${base}.json`, JSON.stringify(report, null, 2))
    writeFileSync(`${base}.md`, buildMarkdownAOnly(report, pair))
    console.log("REPORT_JSON", `${base}.json`)
    console.log("REPORT_MD", `${base}.md`)
    console.log(JSON.stringify({
      pair: `${pair.leftLabel}_vs_${pair.rightLabel}`,
      calls: stats.calls,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      failed_calls: stats.failedCalls,
      retries: stats.retries,
      budget_hit: stats.budgetHit,
      experiment_a: report.experiment_a.metrics,
    }, null, 2))
    return
  }

  const a = await runExperimentA()
  const b = await runExperimentB()
  const report = buildReport(a, b)
  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2))
  writeFileSync(REPORT_MD, buildMarkdown(report))
  console.log("REPORT_JSON", REPORT_JSON)
  console.log("REPORT_MD", REPORT_MD)
  console.log(JSON.stringify({
    calls: stats.calls,
    input_tokens: stats.inputTokens,
    output_tokens: stats.outputTokens,
    failed_calls: stats.failedCalls,
    budget_hit: stats.budgetHit,
    experiment_a: report.experiment_a.metrics,
    experiment_b: report.experiment_b.metrics,
  }, null, 2))
}

main().catch((e) => {
  noteError("fatal", e)
  console.error(e && e.stack ? e.stack : e)
  process.exitCode = 1
})
