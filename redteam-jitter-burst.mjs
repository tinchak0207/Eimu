import fs from "node:fs";
const KEY = fs.readFileSync("/home/lenovo/Desktop/image-app/.env.biz-key", "utf8").match(/sk-biz-[A-Za-z0-9_-]+/)[0];
const BASE = "https://store.tinchak0207.xyz/agent/v1";
const AUTH = { authorization: `Bearer ${KEY}` };
const sid = (await (await fetch(`${BASE}/sessions`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "jitter-burst" }) })).json()).session_id;
const t = await (await fetch(`${BASE}/sessions/${sid}/sse-ticket`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" })).json();
const ac = new AbortController();
let done = false; let textLen = 0; let frameCount = 0;
fetch(`${BASE}/sessions/${sid}/events?ticket=${encodeURIComponent(t.ticket)}`, { signal: ac.signal }).then(async (r) => {
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) {
    const { done: d, value: v } = await rd.read();
    if (d) break;
    buf += dec.decode(v, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const f = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = f.match(/^event:\s*(.+)$/m)?.[1];
      const data = f.match(/^data:\s*(.*)$/m)?.[1] || "";
      frameCount++;
      if (ev === "message.delta") { try { textLen += JSON.parse(data).text.length; } catch {} }
      if (ev === "turn.done") done = true;
    }
  }
}).catch(() => {});
await new Promise((r) => setTimeout(r, 1000));
const msgs = ["用五個字回答：天空是什麼顏色", "用五個字回答：海水是什麼顏色", "用五個字回答：草是什麼顏色", "用五個字回答：炭是什麼顏色", "用五個字回答：雪是什麼顏色"];
let ok = 0, empty = 0;
for (const m of msgs) {
  textLen = 0; done = false;
  await fetch(`${BASE}/sessions/${sid}/messages`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ content: m }) });
  const t0 = Date.now();
  while (Date.now() - t0 < 240000 && !done) await new Promise((r) => setTimeout(r, 2000));
  if (textLen > 0) { ok++; console.log(`[ok] ${m.slice(0, 10)} chars=${textLen}`); } else { empty++; console.log(`[EMPTY] ${m.slice(0, 10)}`); }
}
ac.abort();
console.log(`RESULT ok=${ok} empty=${empty} frames=${frameCount}`);
