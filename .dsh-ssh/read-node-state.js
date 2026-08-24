// 從 SSE replay buffer 讀 session 節點終態（Last-Event-ID 續傳語義，全量 replay）
const fs = require("fs");
const path = require("path");
const key = fs.readFileSync(".env.biz-key", "utf8").match(/sk-biz-[^\s"]+/)[0];
const sessionId = process.argv[2] || "d6ca6574-6f08-4bda-9ad6-4a8d797a2775";
const base = "https://store.tinchak0207.xyz";

async function main() {
  // 1. ticket
  const tRes = await fetch(`${base}/agent/v1/sessions/${sessionId}/sse-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });
  const tJson = await tRes.json().catch(() => ({}));
  if (tRes.status !== 200 || !tJson.ticket) {
    console.log("ticket fail", tRes.status, JSON.stringify(tJson).slice(0, 200));
    return;
  }
  // 2. 全量 replay
  const res = await fetch(
    `${base}/agent/v1/sessions/${sessionId}/events?ticket=${encodeURIComponent(tJson.ticket)}&last_event_id=0`,
    { headers: { Accept: "text/event-stream" } },
  );
  if (res.status !== 200) {
    console.log("events fail", res.status);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const nodes = {};
  const nameCounts = {};
  const nodeAny = {};
  const deadline = Date.now() + 8000; // 只讀 8 秒 replay 就停
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true, value: undefined }), 2000)),
    ]);
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop();
    for (const f of frames) {
      const nameM = f.match(/^event: (.+)$/m);
      const dataM = f.match(/^data: (.+)$/m);
      if (!nameM) continue;
      const name = nameM[1];
      nameCounts[name] = (nameCounts[name] || 0) + 1;
      if (name.startsWith("canvas.node") && dataM) {
        try {
          const d = JSON.parse(dataM[1]);
          const nid = d.id || d.node?.id;
          if (nid) nodeAny[nid] = { ...nodeAny[nid], ...d, ...(d.node || {}), _last: name };
        } catch {}
      }
    }
  }
  console.log("replay event counts:", JSON.stringify(nameCounts));
  console.log("node last state:");
  for (const [id, d] of Object.entries(nodeAny)) {
    console.log(
      `  ${id} :: status=${d.status || "?"} lastEvt=${d._last} err=${(d.error || d.metadata?.error || "").toString().slice(0, 100)}`,
    );
  }
}
main().catch((e) => console.error("ERR", e.message));
