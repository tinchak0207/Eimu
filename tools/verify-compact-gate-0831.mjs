// 0831 修復 3 驗證：壓縮在途閘 + 摘要誠實化。
// 骨架逐行複製 tools/verify-idfix-t2.mjs 的 attachSSE/parse/waitTurn（含 question/confirm 自動回覆），
// 白名單只改用例：① 21 輪極短回覆把訊息數推過 SESSION_COMPACT_THRESHOLD=40
// ② 最後一輪提交真實生圖 → turn.done 時任務仍 queued → 應打出 "compact deferred"
// ③ 等生圖落定後再走一輪 → 壓縮真跑，日誌應出現誠實結果（compacted / FAILED / UNVERIFIED 之一，不得假成功）。
import fs from "node:fs";

const KEY = fs.readFileSync(".env.biz-key", "utf8").match(/sk-biz-[A-Za-z0-9_-]+/)[0];
const BASE = "https://store.tinchak0207.xyz/agent/v1";
const AUTH = { authorization: `Bearer ${KEY}` };
const TURN_MS = 90_000;

async function mkSession() {
  const r = await fetch(`${BASE}/sessions`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "verify-compact-gate-0831" }) });
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
const parse = (raw) => {
  const ev = raw.match(/^event:\s*(.+)$/m)?.[1];
  const data = raw.match(/^data:\s*(.*)$/m)?.[1];
  let obj = null; try { obj = data ? JSON.parse(data) : null; } catch { /* ignore */ }
  return { ev, obj };
};

async function waitTurn(sid, frames, baseIdx) {
  const t0 = Date.now();
  while (Date.now() - t0 < TURN_MS) {
    await sleep(2000);
    for (let i = baseIdx; i < frames.length; i++) {
      const { ev, obj } = parse(frames[i].raw);
      if (frames[i].done) continue;
      const rid = obj?.request_id ?? obj?.id;
      if (ev === "confirm.request" && rid) {
        frames[i].done = true;
        await fetch(`${BASE}/sessions/${sid}/confirm`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, approved: true }) }).catch(() => {});
      }
      if (ev === "question.request" && rid && String(rid).startsWith("que")) {
        frames[i].done = true;
        const questions = Array.isArray(obj?.questions) ? obj.questions : [{}];
        const answers = questions.map((q) => {
          const first = Array.isArray(q?.options) ? (q.options.map((o) => (typeof o === "string" ? o : o?.label ?? o?.text)).find(Boolean)) : null;
          return [first ?? "不需要再确认，直接按我说的做"];
        });
        await fetch(`${BASE}/sessions/${sid}/question`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, answers }) }).catch(() => {});
      }
    }
    if (frames.slice(baseIdx).some((f) => parse(f.raw).ev === "turn.done")) return true;
  }
  return false;
}

async function send(sid, content) {
  const mark = framesGlobal.length;
  await fetch(`${BASE}/sessions/${sid}/messages`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ content }) });
  const ok = await waitTurn(sid, framesGlobal, mark);
  return ok;
}

let framesGlobal = [];
const sid = await mkSession();
console.log(`session=${sid}`);
const { frames, ac, conn } = await attachSSE(sid);
framesGlobal = frames;
await sleep(1500);

// ① 湊訊息數：21 輪極短回覆（每輪 user+assistant = 2 條 → 42 條 > 40）
let turns = 0;
for (let i = 0; i < 21; i++) {
  const ok = await send(sid, "只回复一个字：好");
  turns++;
  if (!ok) console.log(`  第 ${i + 1} 輪未在 ${TURN_MS / 1000}s 內收斂（繼續）`);
  if (frames.some((f) => parse(f.raw).ev === "session.error")) { console.log("  出現 session.error，中止"); break; }
}
console.log(`已走 ${turns} 輪，準備提交在途任務觸發在途閘`);

// ② 提交生圖 → 任務 queued；turn.done 時壓縮應被延後
const imgMark = frames.length;
await send(sid, "只调用一次 image_generate 生成一张 1024x1024 的纯色蓝色图，不要做任何其他事。提交后立即把 task_id 告诉我，不要等待结果。");
const t2submit = frames.slice(imgMark).map((f) => f.raw).join("\n").replace(/\\+"/g, '"');
const submitted = (t2submit.match(/"task_id"\s*:\s*"([0-9a-f-]{36})"/i) || [])[1];
console.log(`生圖提交=${submitted ?? "未取得 task_id"}`);
await sleep(20_000); // 留時間給 turn.done 後的 fire-and-forget 壓縮判定

// ③ 等生圖落定，再走一輪讓壓縮真跑
console.log("等待生成落定後再走一輪，觸發真實壓縮…");
await send(sid, "只回复一个字：好");
await sleep(60_000); // summarize 真跑（含誠實回查）
console.log(`連線：ended=${conn.ended} reason=${conn.reason} 幀數=${frames.length}`);
console.log(`SID=${sid}`);
ac.abort();
