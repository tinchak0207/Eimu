// T2 单项重测：复制 tools/verify-idfix-0831.mjs 的 attachSSE/parse/waitTurn 骨架，
// 白名单改三处：① 复用已登记任务的 session（免再生图）② waitTurn 补 question.request 自动回覆
// （首跑实锤：模型出反问卡 → 回合挂死 260s，前缀纠错路径从未被触发）③ 只跑 T2 断言。
import fs from "node:fs";

if (process.env.ALLOW_PROD_VERIFY !== "1") {
  console.error("拒绝执行：必须设置 ALLOW_PROD_VERIFY=1。未设置时不读生产 key，也不对生产下单。");
  process.exit(1);
}

const KEY = fs.readFileSync(".env.biz-key", "utf8").match(/sk-biz-[A-Za-z0-9_-]+/)[0];
const BASE = "https://store.eimu.dev/agent/v1";
const AUTH = { authorization: `Bearer ${KEY}` };
const TURN_MS = 200_000;

const SID = process.argv[2];
const REAL_ID = process.argv[3];
if (!SID || !REAL_ID) {
  console.error("用法: node tools/verify-idfix-t2.mjs <session_id> <真实 task_id>");
  process.exit(2);
}
const prefix8 = REAL_ID.slice(0, 8);
const fakeTail = `${prefix8}-57b2-4685-9a55-185a99f849b0`; // 事故现场的形状：真前缀 + 假尾巴

async function attachSSE(sid) {
  const t = await (await fetch(`${BASE}/sessions/${sid}/sse-ticket`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" })).json();
  const frames = [];
  const ac = new AbortController();
  const conn = { ended: false, reason: "" };
  fetch(`${BASE}/sessions/${sid}/events?ticket=${encodeURIComponent(t.ticket)}`, { signal: ac.signal, headers: { accept: "text/event-stream" } })
    .then(async (res) => {
      const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      while (true) {
        const { done, value } = await rd.read();
        if (done) { conn.ended = true; conn.reason = "stream-done"; break; }
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          frames.push({ raw: frame, ts: Date.now() });
        }
      }
    }).catch((e) => { conn.ended = true; conn.reason = `err:${String(e?.message || e)}`; });
  return { frames, ac, conn };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (raw) => {
  const ev = raw.match(/^event:\s*(.+)$/m)?.[1];
  const data = raw.match(/^data:\s*(.*)$/m)?.[1];
  let obj = null; try { obj = data ? JSON.parse(data) : null; } catch { /* ignore */ }
  return { ev, obj };
};
const norm = (s) => s.replace(/\\+"/g, '"');
const evSeq = (frames, from) => frames.slice(from).map((f) => parse(f.raw).ev).filter(Boolean).join(",");

async function waitTurn(sid, frames, baseIdx) {
  const t0 = Date.now();
  let approved = 0, answered = 0;
  while (Date.now() - t0 < TURN_MS) {
    await sleep(2500);
    for (let i = baseIdx; i < frames.length; i++) {
      const { ev, obj } = parse(frames[i].raw);
      if (frames[i].done) continue;
      const rid = obj?.request_id ?? obj?.id;
      if (ev === "confirm.request" && rid) {
        frames[i].done = true;
        await fetch(`${BASE}/sessions/${sid}/confirm`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, approved: true }) }).catch(() => {});
        approved++;
      }
      if (ev === "question.request" && rid && String(rid).startsWith("que")) {
        frames[i].done = true;
        // answers 契约 = string[][]（每题一个选中字串）；取第一选项，无选项则回自由文本。
        const questions = Array.isArray(obj?.questions) ? obj.questions : [{}];
        const answers = questions.map((q) => {
          const first = Array.isArray(q?.options) ? (q.options.map((o) => (typeof o === "string" ? o : o?.label ?? o?.text)).find(Boolean)) : null;
          return [first ?? "不需要再确认，直接按我说的做"];
        });
        const r = await fetch(`${BASE}/sessions/${sid}/question`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, answers }) });
        if (r.ok) answered++;
        else console.log(`  question 回覆失败 ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }
    }
    if (frames.slice(baseIdx).some((f) => parse(f.raw).ev === "turn.done")) break;
  }
  return { approved, answered };
}

try {
  const { frames, ac, conn } = await attachSSE(SID);
  await sleep(1500);
  const mark = frames.length;
  await fetch(`${BASE}/sessions/${SID}/messages`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({
    content: `禁止使用 question 工具，禁止反问我任何问题。只调用一次 image_get_result，参数 task_id 精确填这个值：${fakeTail} 。不要调用其他工具，不要解释，调用完直接把工具返回内容贴给我。`,
  }) });
  const { approved, answered } = await waitTurn(SID, frames, mark);
  await sleep(10_000);
  const t2 = norm(frames.slice(mark).map((f) => f.raw).join("\n"));
  const corrected = /id_corrected_from/.test(t2);
  const gotUrl = t2.includes(REAL_ID) || new RegExp(`${prefix8}[0-9a-f-]{27}/[^\\s"')]*\\.(png|jpe?g|webp)`, "i").test(t2);
  console.log(`[T2] ${corrected && gotUrl ? "PASS" : "FAIL"} — 自动纠错=${corrected} 回真 URL=${gotUrl} 批confirm=${approved} 应question=${answered}`);
  console.log(`  事件序列=[${evSeq(frames, mark)}]`);
  if (!(corrected && gotUrl)) console.log(`  样本：${t2.slice(-1800)}`);
  console.log(`连线：ended=${conn.ended} reason=${conn.reason} 帧数=${frames.length}`);
  ac.abort();
  process.exit(corrected && gotUrl ? 0 : 1);
} catch (e) {
  console.log(`[T2] FAIL — ${String(e?.message || e)}`);
  process.exit(1);
}
