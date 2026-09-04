// 互動模式 smoke test：settings roundtrip / 400 / auto 注入實證 / preset 無異常 / 還原現場
// 複製 redteam-smoke.mjs 的鑑權/建會話/SSE 收集/turn() 模式，白名單改測試用例與斷言
import fs from "node:fs";

const KEY = fs.readFileSync(".env.biz-key", "utf8").match(/sk-biz-[A-Za-z0-9_-]+/)[0];
const BASE = "https://store.tinchak0207.xyz/agent/v1";
const AUTH = { authorization: `Bearer ${KEY}` };
const TURN_TIMEOUT_MS = 150_000; // 單輪 LLM 回覆超 150s 視為該用例 FAIL

async function mkSession() {
  const r = await fetch(`${BASE}/sessions`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "smoke-interaction" }) });
  return (await r.json()).session_id;
}
async function getSettings() {
  const r = await fetch(`${BASE}/settings`, { headers: AUTH });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function postSettings(mode) {
  const r = await fetch(`${BASE}/settings`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ interaction_mode: mode }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// 深度搜尋 JSON 中 interaction_mode 的值（容錯巢狀結構）
function findMode(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) { for (const v of obj) { const m = findMode(v); if (m !== undefined) return m; } return undefined; }
  if ("interaction_mode" in obj) return obj.interaction_mode;
  for (const v of Object.values(obj)) { const m = findMode(v); if (m !== undefined) return m; }
  return undefined;
}

async function turn(sid, content, timeoutMs = TURN_TIMEOUT_MS) {
  const t = await (await fetch(`${BASE}/sessions/${sid}/sse-ticket`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: "{}" })).json();
  const events = [];
  const ac = new AbortController();
  fetch(`${BASE}/sessions/${sid}/events?ticket=${encodeURIComponent(t.ticket)}`, { signal: ac.signal, headers: { accept: "text/event-stream" } })
    .then(async (res) => {
      const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      while (true) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = frame.match(/^event:\s*(.+)$/m)?.[1];
          const data = frame.match(/^data:\s*(.*)$/m)?.[1];
          if (ev && data && ev !== "ping") events.push({ ev, data });
        }
      }
    }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  await fetch(`${BASE}/sessions/${sid}/messages`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ content }) });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    if (events.some((e) => e.ev === "turn.done" || /session\.error/.test(e.ev))) break;
  }
  ac.abort();
  const reply = events.filter((e) => e.ev === "message.delta").map((e) => { try { return JSON.parse(e.data).text; } catch { return ""; } }).join("");
  return { events, reply };
}

const results = [];
function record(n, pass, detail) { results.push({ n, pass, detail }); console.log(`[T${n}] ${pass ? "PASS" : "FAIL"}`); }

// ---- T1 settings roundtrip ----
try {
  const g1 = await getSettings();
  const m1 = findMode(g1.body);
  const ok1 = g1.status === 200 && ["collaborate", "preset", "auto"].includes(m1);
  if (!ok1) throw new Error(`GET settings status=${g1.status} interaction_mode=${JSON.stringify(m1)}`);
  const p1 = await postSettings("auto");
  if (p1.status !== 200) throw new Error(`POST auto status=${p1.status} body=${JSON.stringify(p1.body).slice(0, 200)}`);
  const g2 = await getSettings();
  const m2 = findMode(g2.body);
  if (m2 !== "auto") throw new Error(`POST auto 後 GET = ${JSON.stringify(m2)}`);
  record(1, true, `GET=${m1} → POST auto → GET=${m2}`);
} catch (e) { record(1, false, String(e.message || e)); }

// ---- T2 非法值 400 ----
try {
  const r = await postSettings("chaos");
  if (r.status !== 400) throw new Error(`POST interaction_mode=chaos 期望 400，實際 ${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`);
  record(2, true, "chaos 被拒 400");
} catch (e) { record(2, false, String(e.message || e)); }

// ---- T3 注入實證（auto 檔）----
try {
  const p = await postSettings("auto");
  if (p.status !== 200) throw new Error(`設 auto 失敗 status=${p.status}`);
  const sid = await mkSession();
  const r = await turn(sid, "用一句话复述你当前生效的互动模式指令要求你做什么");
  const evNames = r.events.map((e) => e.ev);
  if (!evNames.includes("turn.done")) throw new Error(`未收到 turn.done（${TURN_TIMEOUT_MS / 1000}s 內）。事件：[${evNames.join(", ")}]`);
  const bad = evNames.filter((n) => /question\.request|confirm\.request/i.test(n));
  if (bad.length > 0) throw new Error(`出現禁用事件：${[...new Set(bad)].join(", ")}`);
  if (!/自动|自主|自動/.test(r.reply)) throw new Error(`回覆缺「自动/自主」關鍵詞。回覆前 200 字：${r.reply.slice(0, 200)}`);
  record(3, true, `turn.done，無 question/confirm，回覆命中關鍵詞`);
} catch (e) { record(3, false, String(e.message || e)); }

// ---- T4 preset 檔無異常 ----
try {
  const p = await postSettings("preset");
  if (p.status !== 200) throw new Error(`設 preset 失敗 status=${p.status}`);
  const sid = await mkSession();
  const r = await turn(sid, "回复两个字：收到");
  const evNames = r.events.map((e) => e.ev);
  if (!evNames.includes("turn.done")) throw new Error(`未收到 turn.done。事件：[${evNames.join(", ")}]`);
  if (evNames.some((n) => /session\.error/.test(n))) throw new Error("session.error crash");
  const bad = evNames.filter((n) => /question\.request|confirm\.request/i.test(n));
  if (bad.length > 0) throw new Error(`出現 question/confirm 事件：${[...new Set(bad)].join(", ")}`);
  record(4, true, "turn.done，無 crash，無 question/confirm");
} catch (e) { record(4, false, String(e.message || e)); }

// ---- T5 還原現場 ----
try {
  const p = await postSettings("preset");
  if (p.status !== 200) throw new Error(`POST preset status=${p.status} body=${JSON.stringify(p.body).slice(0, 200)}`);
  const g = await getSettings();
  const m = findMode(g.body);
  if (m !== "preset") throw new Error(`還原後 GET = ${JSON.stringify(m)}`);
  record(5, true, "已還原 preset");
} catch (e) { record(5, false, String(e.message || e)); }

// ---- RESULTS 汇总 ----
console.log("\n===== RESULTS =====");
for (const { n, pass, detail } of results) console.log(`T${n} ${pass ? "PASS" : "FAIL"} — ${detail}`);
const failed = results.filter((r) => !r.pass);
console.log(`===== ${results.length - failed.length}/${results.length} PASS =====`);
process.exit(failed.length ? 1 : 0);
