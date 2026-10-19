// R9 复测 v2：捕获所有原始帧（含 ping）与连线终止原因，等待 75s 盖两个心跳周期
import fs from "node:fs";

const KEY = fs.readFileSync(".env.biz-key", "utf8").match(/sk-biz-[A-Za-z0-9_-]+/)[0];
const BASE = "https://store.eimu.dev/agent/v1";
const AUTH = { authorization: `Bearer ${KEY}` };
const WATCH_MS = 75_000;

async function mkSession() {
  const r = await fetch(`${BASE}/sessions`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "r9-retest-v2" }) });
  return (await r.json()).session_id;
}

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

const results = [];
function record(n, pass, detail) { results.push({ n, pass, detail }); console.log(`[T${n}] ${pass ? "PASS" : "FAIL"} — ${detail}`); }

try {
  const sid = await mkSession();
  const { frames, ac, conn } = await attachSSE(sid);
  await sleep(1200);

  await fetch(`${BASE}/sessions/${sid}/messages`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({
    content: "在开工之前，有一个必须由我来拍板的决策：这本书的改编基调，你给出你的专业建议，但请用 question 工具做成卡片问我：是『忠于原著的历史正剧』还是『戏剧化改编的爽片节奏』。请先出这一张卡，不要做任何生成。"
  }) });

  const t0 = Date.now();
  while (Date.now() - t0 < WATCH_MS) {
    await sleep(2000);
    const qReq = frames.find((f) => /^event:\s*question\.request/m.test(f.raw));
    if (qReq && Date.now() - qReq.ts > 35_000) break; // 出卡后看满 35s 盖一个心跳
    if (conn.ended) break;
    if (frames.some((f) => /^event:\s*session\.error/m.test(f.raw))) break;
  }
  ac.abort();

  const parse = (raw) => {
    const ev = raw.match(/^event:\s*(.+)$/m)?.[1];
    const data = raw.match(/^data:\s*(.*)$/m)?.[1];
    let obj = null; try { obj = data ? JSON.parse(data) : null; } catch { /* ignore */ }
    return { ev, obj };
  };
  const parsed = frames.map((f) => ({ ...parse(f.raw), ts: f.ts })).filter((p) => p.ev !== undefined);
  const names = parsed.map((p) => p.ev);
  const hb = parsed.filter((p) => p.ev === "heartbeat");
  const replays = parsed.filter((p) => p.ev === "message.delta" && /等待你的选择/.test(p.obj?.text ?? ""));
  const qReq = parsed.find((p) => p.ev === "question.request");
  const frozenTurnDone = qReq ? parsed.filter((p) => p.ev === "turn.done" && p.ts > qReq.ts) : [];

  console.log(`  连线：ended=${conn.ended} reason=${conn.reason}`);
  console.log(`  帧数=${frames.length} 事件序列：[${names.join(", ")}]`);
  console.log(`  question.request=${!!qReq} heartbeat×${hb.length} 复读message.delta×${replays.length} 挂起后turn.done×${frozenTurnDone.length}`);
  if (hb.length > 0) console.log(`  心跳样本：${JSON.stringify(hb[0].obj).slice(0, 120)}`);
  if (replays.length > 0) console.log(`  复读样本：${JSON.stringify(replays[0].obj).slice(0, 120)}`);

  const ok = !!qReq && hb.length >= 1 && replays.length === 0 && frozenTurnDone.length === 0;
  record(1, ok, `出卡=${!!qReq} 心跳=${hb.length} 复读=${replays.length} 挂起turn.done=${frozenTurnDone.length} 连线${conn.ended ? `断:${conn.reason}` : "存活"}`);
} catch (e) { record(1, false, String(e.message || e)); }

console.log("\n===== RESULTS =====");
for (const { n, pass, detail } of results) console.log(`T${n} ${pass ? "PASS" : "FAIL"} — ${detail}`);
const failed = results.filter((r) => !r.pass);
console.log(`===== ${results.length - failed.length}/${results.length} PASS =====`);
process.exit(failed.length ? 1 : 0);
