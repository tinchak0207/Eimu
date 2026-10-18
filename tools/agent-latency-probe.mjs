// 生产延迟探针：同一把 biz key、同一个用户路径，量「发送 → 首个 reasoning/正文/工具 → done」。
// 轮次与 SSE 收集照抄 tools/agent-smoke-interaction.mjs（鉴权、sse-ticket、事件解析），
// 只增加时间戳。用途：发布前后各跑一次，对比首字与工具首调，不写任何产品状态。
//
// 用法：
//   node tools/agent-latency-probe.mjs [--turns 5] [--label before] [--out /tmp/probe.jsonl]
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const TURNS = Number(opt("turns", "5"));
const LABEL = opt("label", "run");
const OUT = opt("out", `/tmp/agent-latency-${LABEL}.jsonl`);

const KEY = fs.readFileSync(".env.biz-key", "utf8").match(/sk-biz-[A-Za-z0-9_-]+/)[0];
const BASE = "https://store.tinchak0207.xyz/agent/v1";
const AUTH = { authorization: `Bearer ${KEY}` };
const TURN_TIMEOUT_MS = 120_000;

const PROMPTS = [
  "用三句话介绍你能做什么。",
  "用 bash 执行 `date +%Y-%m-%d`，把结果原样告诉我。",
  "看看当前工作目录里有哪些文件，最多列 5 个。",
  "把你刚看到的文件列表压缩成一句话。",
  "用一句话说明你更喜欢哪种任务：写代码还是查资料。",
];

async function mkSession(i) {
  const r = await fetch(`${BASE}/sessions`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ title: `latency-${LABEL}-${i}` }),
  });
  const j = await r.json();
  if (!j.session_id) throw new Error(`create session failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.session_id;
}

function readSse(url, signal, onEvent) {
  fetch(url, { signal, headers: { accept: "text/event-stream" } })
    .then(async (res) => {
      if (!res.body) return;
      const rd = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = frame.match(/^event:\s*(.+)$/m)?.[1];
          const data = frame.match(/^data:\s*(.*)$/m)?.[1];
          if (ev && data && ev !== "ping") onEvent(ev, data);
        }
      }
    })
    .catch(() => {});
}

async function runTurn(prompt, i) {
  const sid = await mkSession(i);
  const t = await (
    await fetch(`${BASE}/sessions/${sid}/sse-ticket`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: "{}",
    })
  ).json();
  let t0 = 0;
  const marks = { reasoning: null, text: null, tool: null, done: null, error: null };
  let textChars = 0;
  let toolName = null;
  const ac = new AbortController();
  readSse(`${BASE}/sessions/${sid}/events?ticket=${encodeURIComponent(t.ticket)}`, ac.signal, (ev, data) => {
    if (marks.done !== null || marks.error !== null) return;
    try {
      if (ev === "reasoning.delta" && marks.reasoning === null) marks.reasoning = Date.now() - t0;
      if (ev === "message.delta") {
        const p = JSON.parse(data);
        textChars += (p.text || "").length;
        if (marks.text === null && p.text) marks.text = Date.now() - t0;
      }
      if (ev === "tool.invoke" && marks.tool === null) {
        marks.tool = Date.now() - t0;
        try {
          toolName = JSON.parse(data).name ?? JSON.parse(data).tool ?? null;
        } catch {}
      }
      if (ev === "session.error") marks.error = Date.now() - t0;
      if (ev === "turn.done") marks.done = Date.now() - t0;
    } catch {}
  });
  await new Promise((r) => setTimeout(r, 1200));
  t0 = Date.now();
  await fetch(`${BASE}/sessions/${sid}/messages`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ content: prompt }),
  });
  const start = Date.now();
  while (Date.now() - start < TURN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 250));
    if (marks.done !== null || marks.error !== null) break;
  }
  ac.abort();
  return {
    label: LABEL,
    session: sid,
    prompt: prompt.slice(0, 40),
    d_reasoning_ms: marks.reasoning,
    d_text_ms: marks.text,
    d_tool_ms: marks.tool,
    tool: toolName,
    text_chars: textChars,
    d_done_ms: marks.done,
    d_error_ms: marks.error,
    zero_output: textChars === 0,
  };
}

const rows = [];
for (let i = 0; i < Math.min(TURNS, PROMPTS.length); i++) {
  const row = await runTurn(PROMPTS[i], i);
  rows.push(row);
  console.log(JSON.stringify(row));
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const vals = (k) => rows.map((r) => r[k]).filter((v) => typeof v === "number").sort((a, b) => a - b);
const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
const summary = {
  label: LABEL,
  turns: rows.length,
  zero_output: rows.filter((r) => r.zero_output).length,
  first_text_p50: q(vals("d_text_ms"), 0.5),
  first_text_max: vals("d_text_ms").at(-1) ?? null,
  first_tool_p50: q(vals("d_tool_ms"), 0.5),
  first_reasoning_p50: q(vals("d_reasoning_ms"), 0.5),
  done_p50: q(vals("d_done_ms"), 0.5),
};
console.log("SUMMARY " + JSON.stringify(summary));
fs.writeFileSync(OUT.replace(/\.jsonl$/, ".summary.json"), JSON.stringify(summary, null, 2));
