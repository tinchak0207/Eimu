#!/usr/bin/env node
// 真人对话 e2e。语料只来自 tools/human-conversation-corpus.json，每条都有生产会话来源。
// 驱动方式与人一样：建会话、先接 SSE、发原话、把这一回合听到安静为止。
// 一轮里会有多次 turn.done（每步助手消息各一次）。以第一次为准就会在确认卡和成片之前离场。
// 断言看 SSE 帧、会话席位、工程图 brief 原文、生成回执。不看模型自写的「测试通过」。
// 单元测试绿灯、workflow_write 覆盖率、自签 QC、模型编出来的句子，都不能代替本脚本。
//
// 用法：node tools/human-conversation-e2e.mjs [--only=id,id] [--no-spend]
// 密钥从仓库根 .env.biz-key 读，不打印。证据写到 /tmp/human-e2e-<时间>/。

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const CORPUS_PATH = path.join(ROOT, "tools/human-conversation-corpus.json")
const BASE = process.env.EIMU_AGENT_BASE || "https://store.tinchak0207.xyz/agent/v1"
const SSH_KEY = process.env.GW_SSH_KEY || "/home/lenovo/.ssh/new.pem"
const SSH_TARGET = process.env.GW_SSH_TARGET || "ubuntu@43.172.85.76"
const SSH_PORT = process.env.GW_SSH_PORT || "22443"
const TURN_MS = Number(process.env.HUMAN_E2E_TURN_MS || 18 * 60 * 1000)
const QUIET_MS = Number(process.env.HUMAN_E2E_QUIET_MS || 25 * 1000)
const ONLY = new Set((process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean))
const NO_SPEND = process.argv.includes("--no-spend")

function loadKey() {
  const raw = fs.readFileSync(path.join(ROOT, ".env.biz-key"), "utf8")
  const key = raw.match(/sk-biz-[A-Za-z0-9_-]+/)?.[0]
  if (!key) throw new Error("找不到 sk-biz key")
  return key
}

const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf8"))
for (const scene of corpus.scenes) {
  if (!scene.source?.session || !scene.source.session.startsWith("ses_")) {
    throw new Error(`${scene.id} 没有生产会话来源，拒绝当语料`)
  }
  if (!Array.isArray(scene.turns) || scene.turns.some((t) => typeof t !== "string" || t.length < 8)) {
    throw new Error(`${scene.id} 的原话不完整`)
  }
}

const KEY = loadKey()
const AUTH = { authorization: `Bearer ${KEY}` }
const OUT = `/tmp/human-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`
fs.mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseFrame(raw) {
  const ev = raw.match(/^event:\s*(.+)$/m)?.[1] || ""
  const data = raw.match(/^data:\s*(.*)$/m)?.[1] || ""
  let obj = null
  try { obj = data ? JSON.parse(data) : null } catch { obj = null }
  return { ev, obj, data }
}

async function attach(sid) {
  const ticket = await (await fetch(`${BASE}/sessions/${sid}/sse-ticket`, {
    method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}",
  })).json()
  const frames = []
  const ac = new AbortController()
  const readerDone = fetch(`${BASE}/sessions/${sid}/events?ticket=${encodeURIComponent(ticket.ticket)}`, {
    signal: ac.signal, headers: { accept: "text/event-stream" },
  }).then(async (res) => {
    const rd = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    while (true) {
      const { done, value } = await rd.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const ev = raw.match(/^event:\s*(.+)$/m)?.[1]
        if (ev && ev !== "ping") frames.push({ raw, handled: false })
      }
    }
  }).catch(() => {})
  await sleep(800)
  return {
    frames,
    stop() { ac.abort(); return readerDone },
  }
}

async function createSession(title) {
  const res = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.session_id) throw new Error(`建会话失败 http=${res.status}`)
  return body.session_id
}

function replyText(frames, from) {
  return frames.slice(from).map((f) => {
    const { ev, obj } = parseFrame(f.raw)
    if (ev !== "message.delta") return ""
    return typeof obj?.text === "string" ? obj.text : ""
  }).join("")
}

function eventNames(frames, from) {
  return frames.slice(from).map((f) => parseFrame(f.raw).ev)
}

// 第 1 刀画布投影：把 cu_* 单元的 created/updated/deleted 帧回放成最终节点状态，只留结果节点。
function canvasResultNodes(frames) {
  const nodes = new Map()
  for (const f of frames) {
    const { ev, obj } = parseFrame(f.raw)
    if (!String(obj?.unit_id || "").startsWith("cu_")) continue
    if (ev === "canvas.node.created" && obj?.node?.id) {
      const m = obj.node.metadata || {}
      nodes.set(obj.node.id, { type: obj.node.type, status: m.status, content: m.content || "", result: obj.target_kind === "result", code: null })
    } else if (ev === "canvas.node.updated" && nodes.has(obj?.node_id)) {
      const n = nodes.get(obj.node_id), p = obj.patch || {}
      if (p.status) n.status = p.status
      if (typeof p.content === "string") n.content = p.content
      if (p.errorDetails?.code) n.code = p.errorDetails.code
    } else if (ev === "canvas.node.deleted") nodes.delete(obj?.node_id)
  }
  return [...nodes.entries()].filter(([, n]) => n.result).map(([id, n]) => ({ id, ...n }))
}

async function sshPy(code) {
  const r = spawnSync("ssh", [
    "-i", SSH_KEY, "-p", SSH_PORT, "-o", "ConnectTimeout=12", SSH_TARGET, "python3", "-",
  ], { input: code, encoding: "utf8", timeout: 30000 })
  if (r.status !== 0) throw new Error(`ssh python 失败 ${r.stderr?.slice(0, 200) || r.status}`)
  return r.stdout
}

async function sessionFacts(sessionId) {
  const code = `
import json, sqlite3, os
sid = ${JSON.stringify(sessionId)}
db = sqlite3.connect("file:/opt/agent-harness/state/sessions.db?mode=ro", uri=True)
row = db.execute("SELECT data FROM sessions WHERE id=?", (sid,)).fetchone()
seat = project = None
if row:
    d = json.loads(row[0])
    seat = d.get("seat")
    project = d.get("projectMode")
receipts = db.execute("SELECT count(*) FROM generation_receipts WHERE parent_gw=?", (sid,)).fetchone()[0]
brief = ""
p = f"/opt/agent-harness/workspace/projects/{sid}/project.json"
if os.path.exists(p):
    g = json.load(open(p))
    brief = "\\n".join((b.get("text") or "") for b in g.get("brief") or [])
print(json.dumps({"seat": seat, "projectMode": project, "receipts": receipts, "brief": brief}, ensure_ascii=False))
`
  const out = await sshPy(code)
  return JSON.parse(out.trim().split("\n").pop())
}

function optionCoins(option) {
  const src = `${option?.label || ""} ${option?.description || ""}`
  const m = src.match(/(\d+(?:\.\d+)?)\s*币/)
  return m ? Number(m[1]) : null
}

// 答的是卡片上的原文。要花钱的场景只点上限内、标了价的那条；不生成的场景不点开工项。
function answersFor(questions, content, opts) {
  const picks = []
  const answers = questions.map((q) => {
    const options = Array.isArray(q?.options) ? q.options : []
    if (!opts.spend) {
      const stop = options.find((o) => /别生成|不要|不生成|取消|先别/.test(String(o?.label || "")))
      const label = stop?.label || content.slice(0, 80)
      picks.push(label)
      return [label]
    }
    const priced = options
      .map((o) => ({ label: String(o?.label || ""), coins: optionCoins(o) }))
      .filter((o) => o.label && o.coins != null && o.coins <= opts.maxCoins && o.coins > 0)
    if (priced.length) {
      const rec = priced.find((o) => /推荐/.test(o.label)) || priced.sort((a, b) => a.coins - b.coins)[0]
      picks.push(rec.label)
      return [rec.label]
    }
    const label = content.slice(0, 80)
    picks.push(label)
    return [label]
  })
  return { answers, picks }
}

async function runTurn(sid, content, opts) {
  const sse = opts.sse
  const from = sse.frames.length
  const sent = await fetch(`${BASE}/sessions/${sid}/messages`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })
  if (!sent.ok && sent.status !== 202) throw new Error(`发消息 http=${sent.status}`)
  const t0 = Date.now()
  let approved = 0
  let rejected = 0
  let maxQuoted = 0
  let approvedCoins = 0
  let lastNew = Date.now()
  let seen = sse.frames.length
  let polls = 0
  const picks = []
  while (Date.now() - t0 < TURN_MS) {
    await sleep(2000)
    if (sse.frames.length !== seen) {
      seen = sse.frames.length
      lastNew = Date.now()
    }
    for (let i = from; i < sse.frames.length; i++) {
      const frame = sse.frames[i]
      if (frame.handled) continue
      const { ev, obj } = parseFrame(frame.raw)
      const rid = obj?.request_id ?? obj?.id
      if (ev === "confirm.request" && rid) {
        frame.handled = true
        const amount = Number(obj?.amount_coins ?? 0)
        if (Number.isFinite(amount)) maxQuoted = Math.max(maxQuoted, amount)
        const allow = opts.spend === true && amount > 0 && amount <= opts.maxCoins && approvedCoins + amount <= opts.maxCoins
        const res = await fetch(`${BASE}/sessions/${sid}/confirm`, {
          method: "POST",
          headers: { ...AUTH, "content-type": "application/json" },
          body: JSON.stringify({ request_id: rid, approved: allow }),
        }).catch(() => null)
        if (res?.ok && allow) {
          approved++
          approvedCoins += amount
        } else if (!allow) rejected++
        lastNew = Date.now()
      }
      if (ev === "question.request" && rid) {
        frame.handled = true
        const questions = Array.isArray(obj?.questions) ? obj.questions : [{}]
        const picked = answersFor(questions, content, opts)
        picks.push(...picked.picks)
        const res = await fetch(`${BASE}/sessions/${sid}/question`, {
          method: "POST",
          headers: { ...AUTH, "content-type": "application/json" },
          body: JSON.stringify({ request_id: rid, answers: picked.answers }),
        }).catch(() => null)
        if (!res?.ok) picks.push(`question http=${res?.status || "err"}`)
        lastNew = Date.now()
      }
    }
    const names = eventNames(sse.frames, from)
    const quiet = Date.now() - lastNew >= QUIET_MS
    const ended = names.includes("turn.done") || names.includes("session.error")
    const mediaDone = names.some((n) => n === "image.done" || n === "video.done" || n === "audio.done")
    if (names.includes("session.error") && quiet) break
    if (opts.spend && approved > 0) {
      polls++
      if (mediaDone) break
      if (quiet || polls % 6 === 0) {
        try {
          const facts = await sessionFacts(sid)
          if (facts.receipts > 0 && quiet) break
        } catch { /* 下一拍再对回执 */ }
      }
      continue
    }
    if (quiet && ended) break
  }
  const names = eventNames(sse.frames, from)
  return {
    reply: replyText(sse.frames, from),
    names,
    approved,
    rejected,
    maxQuoted,
    approvedCoins,
    picks,
    done: names.includes("turn.done"),
    error: names.includes("session.error"),
    mediaDone: names.some((n) => n === "image.done" || n === "video.done" || n === "audio.done"),
  }
}

function fail(reasons, msg) { reasons.push(msg) }

async function sceneQuote(scene, reasons) {
  const sid = await createSession(`human-e2e-${scene.id}`)
  const sse = await attach(sid)
  const turns = []
  for (const content of scene.turns) {
    const turn = await runTurn(sid, content, { sse, spend: false, maxCoins: 0 })
    turns.push({ reply_chars: turn.reply.length, done: turn.done, mediaDone: turn.mediaDone, names: [...new Set(turn.names)] })
    if (!turn.done) fail(reasons, `${scene.id} 没有 turn.done`)
    if (turn.mediaDone) fail(reasons, `${scene.id} 用户说别生成，却出现了成片事件`)
    if (turn.approved) fail(reasons, `${scene.id} 不该批准扣费`)
    const priced = /币|报价|quote/.test(turn.reply) || turn.names.includes("tool.call") || turn.names.some((n) => /quote|tool/.test(n))
    if (!priced && !/币/.test(turn.reply)) fail(reasons, `${scene.id} 回复里没有报价`)
  }
  const facts = await sessionFacts(sid)
  if (facts.seat !== "creator_legacy") fail(reasons, `${scene.id} 席位是 ${facts.seat}，不是 creator_legacy`)
  if (facts.receipts > 0) fail(reasons, `${scene.id} 产生了 ${facts.receipts} 条生成回执`)
  for (const content of scene.turns) {
    if (!facts.brief.includes(content.slice(0, 24))) fail(reasons, `${scene.id} 工程图 brief 没有留下用户原话`)
  }
  await sse.stop()
  return { sid, turns, seat: facts.seat, projectMode: facts.projectMode, receipts: facts.receipts }
}

async function sceneText(scene, reasons) {
  const sid = await createSession(`human-e2e-${scene.id}`)
  const sse = await attach(sid)
  const turn = await runTurn(sid, scene.turns[0], { sse, spend: false, maxCoins: 0 })
  if (!turn.done) fail(reasons, `${scene.id} 没有 turn.done`)
  if (turn.mediaDone) fail(reasons, `${scene.id} 用户说不要音频，却出现了成片事件`)
  const onlyDispatch = /已经派出去了/.test(turn.reply) && turn.reply.length < 80
  if (onlyDispatch || turn.reply.length < 200) fail(reasons, `${scene.id} 本回合没有交歌单正文（${turn.reply.length} 字）`)
  if (!/歌|曲/.test(turn.reply)) fail(reasons, `${scene.id} 正文里没有曲目`)
  const facts = await sessionFacts(sid)
  if (facts.seat !== "creator_legacy") fail(reasons, `${scene.id} 席位是 ${facts.seat}`)
  if (!facts.brief.includes("婚礼晚宴歌单")) fail(reasons, `${scene.id} 工程图没有记下这句原话`)
  await sse.stop()
  return { sid, reply_chars: turn.reply.length, seat: facts.seat, mediaDone: turn.mediaDone }
}

async function sceneGenerate(scene, reasons) {
  if (NO_SPEND) return { skipped: true }
  const sid = await createSession(`human-e2e-${scene.id}`)
  const sse = await attach(sid)
  const turn = await runTurn(sid, scene.turns[0], { sse, spend: true, maxCoins: scene.max_coins })
  if (!turn.done && !turn.mediaDone) fail(reasons, `${scene.id} 回合没有结束`)
  const names = turn.names
  const confirmAt = names.indexOf("confirm.request")
  const mediaAt = names.findIndex((n) => n === "video.done" || n === "image.done" || n === "audio.done")
  if (confirmAt !== -1 && mediaAt !== -1 && mediaAt < confirmAt) fail(reasons, `${scene.id} 成片事件出现在确认卡之前`)
  const facts = await sessionFacts(sid)
  if (facts.seat !== "creator_legacy") fail(reasons, `${scene.id} 席位是 ${facts.seat}`)
  if (!facts.brief.includes("竹林")) fail(reasons, `${scene.id} 工程图没有记下这句原话`)
  if (turn.approved === 0 && turn.maxQuoted > scene.max_coins) {
    fail(reasons, `${scene.id} 报价 ${turn.maxQuoted} 超过上限 ${scene.max_coins}，没有批准，生成后场景未覆盖`)
  }
  if (turn.approved > 0 && facts.receipts < 1 && !turn.mediaDone) fail(reasons, `${scene.id} 批准之后没有回执`)
  if (turn.approved === 0 && facts.receipts < 1 && !turn.mediaDone) {
    fail(reasons, `${scene.id} 这一回合结束了，没有确认卡，也没有回执`)
  }
  const claimedDone = /已完成|已经做好/.test(turn.reply)
  if (claimedDone && facts.receipts < 1 && !turn.mediaDone) fail(reasons, `${scene.id} 没有回执却说完成了`)
  await sse.stop()
  return {
    sid,
    approved: turn.approved,
    approvedCoins: turn.approvedCoins,
    maxQuoted: turn.maxQuoted,
    picks: turn.picks,
    receipts: facts.receipts,
    mediaDone: turn.mediaDone,
    seat: facts.seat,
    reply_chars: turn.reply.length,
  }
}

async function sceneImage(scene, reasons) {
  const sid = await createSession(`human-e2e-${scene.id}`)
  const sse = await attach(sid)
  const turn = await runTurn(sid, scene.turns[0], { sse, spend: true, maxCoins: scene.max_coins })
  const facts = await sessionFacts(sid)
  if (!turn.done && !turn.mediaDone) fail(reasons, `${scene.id} 回合没有结束`)
  for (let i = 0; i < 60 && !eventNames(sse.frames, 0).includes("image.done") && !eventNames(sse.frames, 0).includes("image.failed"); i++) await sleep(3000)
  turn.names = eventNames(sse.frames, 0)
  if (turn.names.includes("image.failed")) fail(reasons, `${scene.id} image.failed`)
  if (!turn.names.includes("image.done")) fail(reasons, `${scene.id} 没有 image.done 事件`)
  if (/blender|渠道.{0,6}不可用|全部不可用/i.test(turn.reply)) fail(reasons, `${scene.id} 回复里出现降级话术：${turn.reply.slice(0, 160)}`)
  await sse.stop()
  return { sid, names: [...new Set(turn.names)].slice(0, 40), approved: turn.approved, maxQuoted: turn.maxQuoted, receipts: facts.receipts, seat: facts.seat, reply: turn.reply.slice(0, 400) }
}


// MV 关键帧场景（2026-10-31）：只批准图片确认卡；视频确认卡拒绝并中止会话。
// 断言：至少一个 image.done；用户可见帧与历史端点都不含内部自修提示／内部端点／挽具路径。
const LEAK_RE = /未提交|改好尺寸|再调用|project_lock_changed|127\.0\.0\.1|\/opt\/|_prompt-routing|\.opencode|机器闸|Resume Next Action|上游只回传/g
function visibleFieldsOf(ev, obj) {
  if (!obj) return []
  if (ev === "tool.result") return [obj.error?.message, obj.error?.human_message].map((v) => [`tool.result:${obj.tool}`, v])
  if (ev === "tool.invoke") return [[`tool.invoke:${obj.tool}`, obj.args_summary]]
  if (ev === "message.delta") return [["message.delta", obj.text]]
  if (ev === "session.error") return [["session.error", obj.message], ["session.error", obj.human_message]]
  if (ev === "subagent.delta") return [["subagent.delta", obj.text]]
  if (ev === "subagent.done") return [["subagent.done", obj.summary]]
  if (ev === "reasoning.delta") return [["reasoning.delta", obj.text]]
  return []
}
function leakHits(pairs) {
  const hits = []
  for (const [where, v] of pairs) {
    if (typeof v !== "string" || !v) continue
    for (const m of v.matchAll(LEAK_RE)) hits.push({ where, match: m[0], ctx: v.slice(Math.max(0, m.index - 60), m.index + 60) })
  }
  return hits
}
async function sceneMvKeyframes(scene, reasons) {
  const sid = await createSession(`human-e2e-${scene.id}`)
  const sse = await attach(sid)
  const sent = await fetch(`${BASE}/sessions/${sid}/messages`, {
    method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ content: scene.turns[0] }),
  })
  if (!sent.ok && sent.status !== 202) throw new Error(`发消息 http=${sent.status}`)
  const t0 = Date.now()
  const capMs = Number(process.env.HUMAN_E2E_MV_MS || 30 * 60 * 1000)
  const log = { confirms: [], questions: [], videoConfirm: null, aborted: false }
  let spent = 0, lastNew = Date.now(), seen = 0, stopAt = 0
  while (Date.now() - t0 < capMs) {
    await sleep(2000)
    if (sse.frames.length !== seen) { seen = sse.frames.length; lastNew = Date.now() }
    for (const frame of sse.frames) {
      if (frame.handled) continue
      const { ev, obj } = parseFrame(frame.raw)
      const rid = obj?.request_id ?? obj?.id
      if (ev === "confirm.request" && rid) {
        frame.handled = true
        const amount = Number(obj?.amount_coins ?? 0)
        const desc = String(obj?.description || "")
        const isVideo = /视频|video|\d+\s*秒/i.test(desc)
        const allow = !isVideo && /图|image/i.test(desc) && amount > 0 && amount <= scene.max_coins_per_confirm && spent + amount <= scene.max_coins
        await fetch(`${BASE}/sessions/${sid}/confirm`, {
          method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, approved: allow }),
        }).catch(() => null)
        if (allow) spent += amount
        log.confirms.push({ at: Math.round((Date.now() - t0) / 1000), amount, desc, approved: allow })
        if (isVideo && !log.videoConfirm) {
          log.videoConfirm = { amount, desc }
          const ab = await fetch(`${BASE}/sessions/${sid}/abort`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" }).catch(() => null)
          log.aborted = !!ab?.ok
          stopAt = Date.now() + 15000
        }
        lastNew = Date.now()
      }
      if (ev === "question.request" && rid) {
        frame.handled = true
        const qs = Array.isArray(obj?.questions) ? obj.questions : [{}]
        const answers = qs.map((q) => {
          const all = Array.isArray(q?.options) ? q.options : []
          const txt = (o) => `${o?.label || ""} ${o?.description || ""}`
          const VIDEO_RE = /视频|video|动态|运镜|镜头.{0,4}段|\d+\s*段/i
          const EXPLICIT_NO = /不要(?:动态镜头|动态|视频)|不做视频|去掉视频|只做(?:静帧|图|关键帧)/
          const planHasVideo = VIDEO_RE.test(String(q?.question || ""))
          const noVideo = all.filter((o) => EXPLICIT_NO.test(txt(o)) || (!planHasVideo && !VIDEO_RE.test(txt(o))))
            .filter((o) => !/只做歌|画面暂停|不要画面/.test(txt(o)))
          let pick = noVideo.find((o) => /不要(?:动态镜头|视频)|不做视频|去掉视频/.test(txt(o))) || noVideo.find((o) => /关键帧|图|推荐/.test(String(o?.label || ""))) || noVideo[0]
          let how = "no-video"
          if (!pick && all.length) { pick = all.map((o) => ({ o, c: optionCoins(o) ?? Infinity })).sort((a, b) => a.c - b.c)[0].o; how = "smallest" }
          log.pickHow = how
          return [pick?.label || "先只做关键帧和音乐，视频先不做"]
        })
        log.questions.push({ questions: qs.map((q) => ({ q: q?.question, options: (q?.options || []).map((o) => o?.label) })), answers })
        await fetch(`${BASE}/sessions/${sid}/question`, {
          method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, answers }),
        }).catch(() => null)
        lastNew = Date.now()
      }
    }
    if (!log.videoSubmit) {
      const vf = sse.frames.find((f) => { const { ev, obj } = parseFrame(f.raw); return ev === "tool.invoke" && !/quote/i.test(String(obj?.tool || "")) && /"kind":"video"/.test(String(obj?.args_summary || "")) })
      if (vf) {
        // 低价视频（≤0.1 币）不弹确认卡，只能从 tool.invoke 看见：立刻中止。
        log.videoSubmit = { at: Math.round((Date.now() - t0) / 1000), args: String(parseFrame(vf.raw).obj?.args_summary || "").slice(0, 200) }
        const ab = await fetch(`${BASE}/sessions/${sid}/abort`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" }).catch(() => null)
        log.aborted = !!ab?.ok
        stopAt = Date.now() + 10000
      }
    }
    if (stopAt && Date.now() > stopAt) break
    const names = eventNames(sse.frames, 0)
    if (scene.stop_after_first_image_ms && !stopAt && names.includes("image.done")) {
      stopAt = Date.now() + scene.stop_after_first_image_ms
      log.firstImageAt = Math.round((Date.now() - t0) / 1000)
      continue
    }
    const raw = sse.frames.map((f) => f.raw).join("\n")
    const musicDone = /"tool":"music_gen"[^\n]*"ok"|event: audio\.(?:done|failed)/.test(raw) || /music_gen[^\n]*(?:ok|error)/.test(sse.frames.filter((f) => parseFrame(f.raw).ev === "tool.result").map((f) => f.raw).join("\n"))
    const imgDone = names.includes("image.done")
    const quiet = Date.now() - lastNew >= QUIET_MS
    if (quiet && names.includes("turn.done") && imgDone && musicDone) break
    if (Date.now() - lastNew >= 5 * 60 * 1000) break
  }
  if (scene.stop_after_first_image_ms && !log.aborted) {
    const ab = await fetch(`${BASE}/sessions/${sid}/abort`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" }).catch(() => null)
    log.aborted = !!ab?.ok
    await sleep(3000)
  }
  fs.writeFileSync(path.join(OUT, `${scene.id}.sse`), sse.frames.map((f) => f.raw).join("\n\n"))
  // delta 帧是逐 token 碎片，逐帧扫会漏掉跨帧的命中：同类 delta 先拼接再扫。
  const DELTA = new Set(["message.delta", "reasoning.delta", "subagent.delta"])
  const joined = {}
  const pairs = sse.frames.flatMap((f) => {
    const { ev, obj } = parseFrame(f.raw)
    if (DELTA.has(ev)) { joined[ev] = (joined[ev] || "") + (typeof obj?.text === "string" ? obj.text : ""); return [] }
    return visibleFieldsOf(ev, obj)
  })
  for (const [ev, text] of Object.entries(joined)) pairs.push([ev, text])
  const reasoningHits = leakHits(pairs.filter(([w]) => w === "reasoning.delta"))
  const sseHits = leakHits(pairs.filter(([w]) => w !== "reasoning.delta"))
  const names = eventNames(sse.frames, 0)
  const imageUrls = sse.frames.map((f) => parseFrame(f.raw)).filter((x) => x.ev === "image.done").map((x) => x.obj?.url)
  await sse.stop()
  const hres = await fetch(`${BASE}/sessions/${sid}/messages`, { headers: AUTH })
  const hist = await hres.json().catch(() => ({}))
  fs.writeFileSync(path.join(OUT, `${scene.id}.history.json`), JSON.stringify(hist))
  const histPairs = []
  for (const m of hist.messages || []) for (const p of m.parts || []) {
    if (p.type === "tool") histPairs.push([`hist.tool.input:${p.tool}`, p.state?.input], [`hist.tool.error:${p.tool}`, typeof p.state?.error === "string" ? p.state.error : p.state?.error?.message])
    else if (typeof p.text === "string") histPairs.push([`hist.${m.info?.role}.${p.type}`, p.text])
  }
  const histReasoningHits = leakHits(histPairs.filter(([w]) => /\.reasoning$/.test(w)))
  const histHits = leakHits(histPairs.filter(([w]) => !/\.reasoning$/.test(w)))
  if (!imageUrls.length) fail(reasons, `${scene.id} 没有 image.done`)
  if (log.videoSubmit) fail(reasons, `${scene.id} 出现视频提交（无确认卡）：${log.videoSubmit.args.slice(0, 80)}`)
  if (sseHits.length) fail(reasons, `${scene.id} SSE 用户可见字段命中 ${sseHits.length}`)
  if (histHits.length) fail(reasons, `${scene.id} 历史端点命中 ${histHits.length}`)
  return { sid, elapsed_s: Math.round((Date.now() - t0) / 1000), spent, ...log, imageUrls, sseHits, histHits, reasoningHits: reasoningHits.length, histReasoningHits: histReasoningHits.length, history_http: hres.status, eventCounts: names.reduce((a, n) => ((a[n] = (a[n] || 0) + 1), a), {}) }
}

// 主会话＋全部子代理的 music_gen／audio_first_timeline 调用（SSE 只给子代理工具状态，参数与回执要从 opencode 库取）。
async function musicGenFacts(sessionId) {
  const code = `
import json, sqlite3
gw = sqlite3.connect("file:/opt/agent-harness/state/sessions.db?mode=ro", uri=True)
row = gw.execute("SELECT opencode_session_id FROM sessions WHERE id=?", (${JSON.stringify(sessionId)},)).fetchone()
db = sqlite3.connect("file:/opt/agent-harness/workspace/.local/share/opencode/opencode.db?mode=ro", uri=True)
ids = [row[0]] if row and row[0] else []
# 网关派遣的子代理是独立 opencode 会话（不挂 parent_id），映射在 subagent_durable_runs。
ids += [r[0] for r in gw.execute("SELECT child_oc FROM subagent_durable_runs WHERE parent_gw=? AND child_oc IS NOT NULL", (${JSON.stringify(sessionId)},)) if r[0] not in ids]
i = 0
while i < len(ids):
    ids += [r[0] for r in db.execute("SELECT id FROM session WHERE parent_id=?", (ids[i],))]
    i += 1
calls, tts = [], []
for sid in ids:
    for (t, d) in db.execute("SELECT time_created, data FROM part WHERE session_id=? AND (data LIKE '%music_gen%' OR data LIKE '%audio_first_timeline%') ORDER BY time_created", (sid,)):
        j = json.loads(d)
        if j.get("type") != "tool":
            continue
        st = j.get("state") or {}
        if j.get("tool") == "audio_first_timeline":
            tts.append({"session": sid, "at": t, "status": st.get("status")})
            continue
        if j.get("tool") != "music_gen":
            continue
        inp = st.get("input") or {}
        out = None
        try:
            out = json.loads(st.get("output") or "")
        except Exception:
            pass
        c = {"session": sid, "at": t, "status": st.get("status"), "probe": inp.get("probe") in (True, "true"),
             "has_lyrics": bool(str(inp.get("lyrics") or "").strip()), "output_parsed": isinstance(out, dict)}
        if isinstance(out, dict):
            err = out.get("error") or {}
            c.update({"ok": out.get("ok"), "channel": out.get("channel"), "fallback_from": out.get("fallback_from"),
                      "fallback_reason": str(out.get("fallback_reason") or "")[:200] or None, "degraded": bool(out.get("degraded")),
                      "error_code": err.get("code") if isinstance(err, dict) else None, "notes": out.get("notes")})
        calls.append(c)
calls.sort(key=lambda c: c["at"])
print(json.dumps({"opencode_session": ids[0] if ids else None, "calls": calls, "tts": tts}, ensure_ascii=False))
`
  const out = await sshPy(code)
  return JSON.parse(out.trim().split("\n").pop())
}

async function sceneMvVocalSong(scene, reasons) {
  const sid = await createSession(`human-e2e-${scene.id}`)
  const sse = await attach(sid)
  const sent = await fetch(`${BASE}/sessions/${sid}/messages`, {
    method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ content: scene.turns[0] }),
  })
  if (!sent.ok && sent.status !== 202) throw new Error(`发消息 http=${sent.status}`)
  const t0 = Date.now()
  const capMs = Number(process.env.HUMAN_E2E_MV_MS || 30 * 60 * 1000)
  const log = { confirms: [], questions: [], videoConfirm: null, aborted: false, followups: [] }
  let spent = 0, lastNew = Date.now(), seen = 0, stopAt = 0, lastMusicPoll = 0, turnIdx = 1
  while (Date.now() - t0 < capMs) {
    await sleep(2000)
    if (sse.frames.length !== seen) { seen = sse.frames.length; lastNew = Date.now() }
    for (const frame of sse.frames) {
      if (frame.handled) continue
      const { ev, obj } = parseFrame(frame.raw)
      const rid = obj?.request_id ?? obj?.id
      if (ev === "confirm.request" && rid) {
        frame.handled = true
        const amount = Number(obj?.amount_coins ?? 0)
        const desc = String(obj?.description || "")
        const isMusic = /音乐|music|歌/i.test(desc)
        const isVideo = /视频|video/i.test(desc) || (!isMusic && /\d+\s*秒/.test(desc))
        const allow = !isVideo && (/图|image/i.test(desc) || isMusic) && amount > 0 && amount <= scene.max_coins_per_confirm && spent + amount <= scene.max_coins
        await fetch(`${BASE}/sessions/${sid}/confirm`, {
          method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, approved: allow }),
        }).catch(() => null)
        if (allow) spent += amount
        log.confirms.push({ at: Math.round((Date.now() - t0) / 1000), amount, desc, approved: allow })
        // 视频卡拒绝即可（闸门已挡住扣费），不中止：本场景要等到人声整歌出来。
        if (isVideo && !log.videoConfirm) log.videoConfirm = { amount, desc }
        lastNew = Date.now()
      }
      // 回合收尾仍没碰 music_gen（只报价／问方向）→ 发下一句用户原话推进。
      if (ev === "turn.done") {
        frame.handled = true
        const musicInvoked = sse.frames.some((f) => parseFrame(f.raw).obj?.tool === "music_gen")
        if (!musicInvoked && turnIdx < scene.turns.length) {
          const text = scene.turns[turnIdx++]
          await fetch(`${BASE}/sessions/${sid}/messages`, {
            method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ content: text }),
          }).catch(() => null)
          log.followups.push({ at: Math.round((Date.now() - t0) / 1000), text })
          lastNew = Date.now()
        }
      }
      if (ev === "question.request" && rid) {
        frame.handled = true
        const qs = Array.isArray(obj?.questions) ? obj.questions : [{}]
        const answers = qs.map((q) => {
          const all = Array.isArray(q?.options) ? q.options : []
          const txt = (o) => `${o?.label || ""} ${o?.description || ""}`
          const VIDEO_RE = /视频|video|动态|运镜|镜头.{0,4}段|\d+\s*段/i
          const EXPLICIT_NO = /不要(?:动态镜头|动态|视频)|不做视频|去掉视频|只做(?:静帧|图|关键帧)/
          const planHasVideo = VIDEO_RE.test(String(q?.question || ""))
          const noVideo = all.filter((o) => EXPLICIT_NO.test(txt(o)) || (!planHasVideo && !VIDEO_RE.test(txt(o))))
            .filter((o) => !/只做歌|画面暂停|不要画面/.test(txt(o)))
          let pick = noVideo.find((o) => /不要(?:动态镜头|视频)|不做视频|去掉视频/.test(txt(o))) || noVideo.find((o) => /关键帧|图|推荐/.test(String(o?.label || ""))) || noVideo[0]
          let how = "no-video"
          if (!pick && all.length) { pick = all.map((o) => ({ o, c: optionCoins(o) ?? Infinity })).sort((a, b) => a.c - b.c)[0].o; how = "smallest" }
          log.pickHow = how
          return [pick?.label || "先只做关键帧和音乐，视频先不做"]
        })
        log.questions.push({ questions: qs.map((q) => ({ q: q?.question, options: (q?.options || []).map((o) => o?.label) })), answers })
        await fetch(`${BASE}/sessions/${sid}/question`, {
          method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, answers }),
        }).catch(() => null)
        lastNew = Date.now()
      }
    }
    if (!log.videoSubmit) {
      const vf = sse.frames.find((f) => { const { ev, obj } = parseFrame(f.raw); return ev === "tool.invoke" && !/quote/i.test(String(obj?.tool || "")) && /"kind":"video"/.test(String(obj?.args_summary || "")) })
      if (vf) {
        // 低价视频（≤0.1 币）不弹确认卡，只能从 tool.invoke 看见：立刻中止。
        log.videoSubmit = { at: Math.round((Date.now() - t0) / 1000), args: String(parseFrame(vf.raw).obj?.args_summary || "").slice(0, 200) }
        const ab = await fetch(`${BASE}/sessions/${sid}/abort`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" }).catch(() => null)
        log.aborted = !!ab?.ok
        stopAt = Date.now() + 10000
      }
    }
    if (stopAt && Date.now() > stopAt) break
    // 等到非 probe 的 music_gen 结果落库（主会话或音乐子代理），再静 QUIET_MS 就收。
    const musicSeen = sse.frames.some((f) => { const { ev, obj } = parseFrame(f.raw); return /^audio\.(?:done|failed)$/.test(ev) || (obj?.tool === "music_gen" && (ev === "tool.result" || (ev === "subagent.tool" && obj?.status !== "running"))) })
    if (!stopAt && musicSeen && Date.now() - lastMusicPoll >= 20000) {
      lastMusicPoll = Date.now()
      const facts = await musicGenFacts(sid).catch(() => null)
      if (facts?.calls?.some((c) => !c.probe && c.output_parsed)) {
        stopAt = Date.now() + QUIET_MS
        log.musicResultAt = Math.round((Date.now() - t0) / 1000)
      }
    }
    if (Date.now() - lastNew >= 5 * 60 * 1000) break
  }
  if (!log.aborted) {
    const ab = await fetch(`${BASE}/sessions/${sid}/abort`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" }).catch(() => null)
    log.aborted = !!ab?.ok
    await sleep(3000)
  }
  fs.writeFileSync(path.join(OUT, `${scene.id}.sse`), sse.frames.map((f) => f.raw).join("\n\n"))
  // delta 帧是逐 token 碎片，逐帧扫会漏掉跨帧的命中：同类 delta 先拼接再扫。
  const DELTA = new Set(["message.delta", "reasoning.delta", "subagent.delta"])
  const joined = {}
  const pairs = sse.frames.flatMap((f) => {
    const { ev, obj } = parseFrame(f.raw)
    if (DELTA.has(ev)) { joined[ev] = (joined[ev] || "") + (typeof obj?.text === "string" ? obj.text : ""); return [] }
    return visibleFieldsOf(ev, obj)
  })
  for (const [ev, text] of Object.entries(joined)) pairs.push([ev, text])
  const reasoningHits = leakHits(pairs.filter(([w]) => w === "reasoning.delta"))
  const sseHits = leakHits(pairs.filter(([w]) => w !== "reasoning.delta"))
  const names = eventNames(sse.frames, 0)
  const imageUrls = sse.frames.map((f) => parseFrame(f.raw)).filter((x) => x.ev === "image.done").map((x) => x.obj?.url)
  await sse.stop()
  const hres = await fetch(`${BASE}/sessions/${sid}/messages`, { headers: AUTH })
  const hist = await hres.json().catch(() => ({}))
  fs.writeFileSync(path.join(OUT, `${scene.id}.history.json`), JSON.stringify(hist))
  const histPairs = []
  for (const m of hist.messages || []) for (const p of m.parts || []) {
    if (p.type === "tool") histPairs.push([`hist.tool.input:${p.tool}`, p.state?.input], [`hist.tool.error:${p.tool}`, typeof p.state?.error === "string" ? p.state.error : p.state?.error?.message])
    else if (typeof p.text === "string") histPairs.push([`hist.${m.info?.role}.${p.type}`, p.text])
  }
  const histReasoningHits = leakHits(histPairs.filter(([w]) => /\.reasoning$/.test(w)))
  const histHits = leakHits(histPairs.filter(([w]) => !/\.reasoning$/.test(w)))
  // 人声整歌断言（2026-10-31 回退 bug：yue2_unreachable 未回落 → 器乐版＋TTS 念白冒充演唱）。
  const music = await musicGenFacts(sid).catch((e) => ({ error: String(e?.message || e), calls: [], tts: [] }))
  const gens = (music.calls || []).filter((c) => !c.probe)
  const vocalOk = gens.find((c) => c.ok === true && c.has_lyrics && !c.degraded)
  const unreachableIdx = gens.findIndex((c) => c.error_code === "yue2_unreachable")
  if (music.error) fail(reasons, `${scene.id} 取 music_gen 记录失败：${music.error}`)
  if (!vocalOk) fail(reasons, `${scene.id} 没有带歌词的成功 music_gen（${gens.map((c) => `${c.ok ? "ok" : c.error_code || "fail"}${c.has_lyrics ? "+词" : "+器乐"}`).join("，") || "无调用"}）`)
  if (unreachableIdx >= 0 && !gens.slice(unreachableIdx + 1).some((c) => c.ok === true && c.has_lyrics && c.fallback_from)) {
    fail(reasons, `${scene.id} 出现 yue2_unreachable 且其后没有成功回落`)
  }
  if ((music.tts || []).length) fail(reasons, `${scene.id} 调用了 audio_first_timeline ${music.tts.length} 次（TTS 冒充演唱）`)
  if (log.videoSubmit) fail(reasons, `${scene.id} 出现视频提交（无确认卡）：${log.videoSubmit.args.slice(0, 80)}`)
  // 画布投影验收（第 1 刀）：成功的音乐/出图都要落成画布结果节点；音频节点不许转圈；被拒的调用不留节点。
  const canvas = canvasResultNodes(sse.frames)
  const audioOk = canvas.filter((n) => n.type === "audio" && n.status === "success" && /^https?:\/\//.test(n.content))
  if (gens.some((c) => c.ok === true) && audioOk.length < gens.filter((c) => c.ok === true).length) {
    fail(reasons, `${scene.id} 成功 music_gen ${gens.filter((c) => c.ok === true).length} 次，画布成功音频节点只有 ${audioOk.length}`)
  }
  const audioStuck = canvas.filter((n) => n.type === "audio" && n.status === "loading")
  if (audioStuck.length) fail(reasons, `${scene.id} 画布音频节点卡在生成中：${audioStuck.map((n) => n.id).join(",")}`)
  const unprojected = imageUrls.filter((u) => u && !canvas.some((n) => n.status === "success" && n.content === u))
  if (unprojected.length) fail(reasons, `${scene.id} ${unprojected.length} 张出图没投影到画布结果节点`)
  const rejectedLeft = canvas.filter((n) => /reject|declin/i.test(String(n.code || "")))
  if (rejectedLeft.length) fail(reasons, `${scene.id} 被拒的调用仍留在画布：${rejectedLeft.map((n) => n.id).join(",")}`)
  if (sseHits.length) fail(reasons, `${scene.id} SSE 用户可见字段命中 ${sseHits.length}`)
  if (histHits.length) fail(reasons, `${scene.id} 历史端点命中 ${histHits.length}`)
  return { sid, music, canvas, elapsed_s: Math.round((Date.now() - t0) / 1000), spent, ...log, imageUrls, sseHits, histHits, reasoningHits: reasoningHits.length, histReasoningHits: histReasoningHits.length, history_http: hres.status, eventCounts: names.reduce((a, n) => ((a[n] = (a[n] || 0) + 1), a), {}) }
}

const runners = {
  "mv-keyframes-no-video": sceneMvKeyframes,
  "mv-vocal-song": sceneMvVocalSong,
  "image-first-try": sceneImage,
  "quote-before-generate": sceneQuote,
  "same-turn-text": sceneText,
  "generate-then-receipt": sceneGenerate,
}

const selected = corpus.scenes.filter((scene) => !ONLY.size || ONLY.has(scene.id))
const results = await Promise.all(selected.map(async (scene) => {
  const reasons = []
  let detail = null
  try {
    detail = await runners[scene.id](scene, reasons)
  } catch (e) {
    reasons.push(String(e?.message || e))
  }
  const row = { id: scene.id, pass: reasons.length === 0, reasons, detail }
  fs.writeFileSync(path.join(OUT, `${scene.id}.json`), JSON.stringify(row, null, 2))
  console.log(`${row.pass ? "PASS" : "FAIL"} ${scene.id}${reasons.length ? " " + reasons.join("；") : ""}`)
  return row
}))

const summary = { out: OUT, pass: results.every((r) => r.pass), results: results.map(({ id, pass, reasons }) => ({ id, pass, reasons })) }
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2))
console.log(summary.pass ? `PASS ${OUT}` : `FAIL ${OUT}`)
process.exit(summary.pass ? 0 : 1)
