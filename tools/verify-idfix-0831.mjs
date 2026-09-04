// 0831 ID 漂移修復驗證：複製 tools/agent-r9-retest.mjs 的 mkSession/attachSSE/record/parse 骨架，
// 白名單只改測試用例與斷言。物理參數（SSE 解析、幀收集、連線終止記錄）一行不動。
//
// 被测根因：壓縮摘要只留 task_id 前 8 碼 → 模型腦補 24 碼假尾巴 → 19 次 404，
// 且站點自己的 404 被網關兜底包成「上游原因」。
import fs from "node:fs";

const KEY = fs.readFileSync(".env.biz-key", "utf8").match(/sk-biz-[A-Za-z0-9_-]+/)[0];
const BASE = "https://store.tinchak0207.xyz/agent/v1";
const AUTH = { authorization: `Bearer ${KEY}` };
const TURN_MS = 260_000; // 單輪上限：含一次真實生圖（實測 gpt-image-2 fast ~150s）

async function mkSession() {
  const r = await fetch(`${BASE}/sessions`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ title: "verify-idfix-0831" }) });
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

const parse = (raw) => {
  const ev = raw.match(/^event:\s*(.+)$/m)?.[1];
  const data = raw.match(/^data:\s*(.*)$/m)?.[1];
  let obj = null; try { obj = data ? JSON.parse(data) : null; } catch { /* ignore */ }
  return { ev, obj };
};

async function send(sid, content) {
  await fetch(`${BASE}/sessions/${sid}/messages`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ content }) });
}

// 等一個回合收斂：turn.done 出現於 baseIdx 之後；期間自動批准 confirm 卡、自動回覆 question 卡。
// （0831 實錘：模型會反問出 question.request 把回合掛死到超時，只批 confirm 不夠。）
async function waitTurn(sid, frames, baseIdx) {
  const t0 = Date.now();
  let approved = 0;
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
        const questions = Array.isArray(obj?.questions) ? obj.questions : [{}];
        const answers = questions.map((q) => {
          const first = Array.isArray(q?.options) ? (q.options.map((o) => (typeof o === "string" ? o : o?.label ?? o?.text)).find(Boolean)) : null;
          return [first ?? "不需要再确认，直接按我说的做"];
        });
        await fetch(`${BASE}/sessions/${sid}/question`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ request_id: rid, answers }) }).catch(() => {});
      }
    }
    if (frames.slice(baseIdx).some((f) => parse(f.raw).ev === "turn.done")) break;
  }
  return approved;
}

const textOf = (frames, from) => frames.slice(from).map((f) => f.raw).join("\n");
// SSE data 內的工具輸出是「JSON 字串再被 JSON 編碼一次」，task_id 在 raw 裡長成 \"task_id\"。
// 先把跳脫引號歸一化，再匹配；否則正則永遠打不中（0831 首跑實測踩過）。
const norm = (s) => s.replace(/\\+"/g, '"');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const findTaskId = (raw) => {
  const t = norm(raw);
  return (t.match(/"task_id"\s*:\s*"([^"]+)"/i) || [])[1]
    || (t.match(/task_id[^\w-]{0,4}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || [])[1];
};
const evSeq = (frames, from) => frames.slice(from).map((f) => parse(f.raw).ev).filter(Boolean).join(",");

try {
  const sid = await mkSession();
  console.log(`session=${sid}`);
  const { frames, ac, conn } = await attachSSE(sid);
  await sleep(1500);

  // ── T1：真實提交一張圖，取回權威 task_id（同時證明生圖鏈未被我方改動打斷）──
  let mark = frames.length;
  await send(sid, "请调用 image_generate 生成一张图：一只戴红色帽子的橘猫，尺寸 1024x1024。只生成这一张，不要做其他任何事。生成后把返回的 task_id 原样完整贴给我。");
  await waitTurn(sid, frames, mark);
  await sleep(25_000); // 等 image.done / poller 續接
  const t1 = textOf(frames, mark);
  const realId = findTaskId(t1);
  record(1, !!realId && UUID_RE.test(realId || ""), realId ? `取得真實 task_id=${realId}` : `未取得 task_id；事件序列=[${evSeq(frames, mark)}]`);

  if (!realId) {
    console.log(`  T1 原始幀樣本（歸一化後）：${norm(t1).slice(0, 1500)}`);
    throw new Error("T1 未取得 task_id，T2/T4 無效");
  }
  const prefix8 = realId.slice(0, 8);
  const fakeTail = `${prefix8}-57b2-4685-9a55-185a99f849b0`; // 事故現場的形狀：真前綴 + 假尾巴

  // ── T2：前綴自動糾錯（核心回歸測試：事故現場的「真前綴+假尾巴」形狀）──
  mark = frames.length;
  await send(sid, `只调用一次 image_get_result，参数 task_id 精确填这个值：${fakeTail} 。不要调用其他工具，不要解释。`);
  await waitTurn(sid, frames, mark);
  await sleep(10_000);
  const t2 = norm(textOf(frames, mark));
  // SSE 的 tool.result 只有 {tool,ok,cost_coins}，**不含工具輸出本體** → 在流裡找
  // id_corrected_from 必假 FAIL（0831 首跑踩過）。假尾巴 ID 在站點必定不存在，
  // 故「這次呼叫回 ok:true」本身就是糾錯成功的充分證據；輸出原文鐵證查 opencode.db：
  //   sudo sqlite3 /opt/agent-harness/workspace/.local/share/opencode/opencode.db \
  //     "select data from part where data like '%<真實ID前8碼>%' and data like '%tool%' order by rowid desc limit 3;"
  const t2ok = /"tool"\s*:\s*"image_get_result"\s*,\s*"ok"\s*:\s*true/.test(t2);
  const t2corrected = /id_corrected_from/.test(t2) || t2ok;
  const t2url = t2.includes(realId) || new RegExp(`${prefix8}[0-9a-f-]{27}/[^\\s"')]*\\.(png|jpe?g|webp)`, "i").test(t2);
  record(2, t2corrected && !/\"ok\"\s*:\s*false/.test(t2), `假尾巴ID回ok=true=${t2corrected}（輸出原文鐵證見 opencode.db）；流內真URL=${t2url}；事件序列=[${evSeq(frames, mark)}]`);

  // ── T3：完全不存在的 ID → 誠實文案，且不得再出現「上游原因」誤標 ──
  mark = frames.length;
  await send(sid, "只调用一次 image_get_result，参数 task_id 精确填这个值：deadbeef-0000-4000-8000-000000000000 。不要调用其他工具。");
  await waitTurn(sid, frames, mark);
  await sleep(10_000);
  const t3 = norm(textOf(frames, mark));
  const t3honest = /这个任务 ID 在平台查不到/.test(t3);
  const t3noLie = !/上游原因/.test(t3);
  record(3, t3honest && t3noLie, `誠實文案=${t3honest} 無「上游原因」誤標=${t3noLie}；事件序列=[${evSeq(frames, mark)}]`);
  if (!t3honest) console.log(`  T3 樣本：${t3.slice(-1200)}`);

  // ── T4：零參數 → 回本輪權威任務清單（含真實完整 UUID）──
  mark = frames.length;
  await send(sid, "只调用一次 image_get_result，不要带任何参数（task_id 留空），把本轮任务清单取回来。不要调用其他工具。");
  await waitTurn(sid, frames, mark);
  await sleep(10_000);
  const t4 = norm(textOf(frames, mark));
  const t4list = /本轮任务清单/.test(t4) || /"tasks"\s*:\s*\[/.test(t4);
  const t4hasId = t4.includes(realId);
  record(4, t4list && t4hasId, `清單模式=${t4list} 含真實完整 UUID=${t4hasId}；事件序列=[${evSeq(frames, mark)}]`);
  if (!(t4list && t4hasId)) console.log(`  T4 樣本：${t4.slice(-1200)}`);

  console.log(`\n連線：ended=${conn.ended} reason=${conn.reason} 幀數=${frames.length}`);
  ac.abort();
} catch (e) {
  record(0, false, String(e?.message || e));
}

console.log("\n===== RESULTS =====");
for (const { n, pass, detail } of results) console.log(`T${n} ${pass ? "PASS" : "FAIL"} — ${detail}`);
const failed = results.filter((r) => !r.pass);
console.log(`===== ${results.length - failed.length}/${results.length} PASS =====`);
process.exit(failed.length ? 1 : 0);
