// 分析 complex-test.json：工具調用序列、對話質量、節點產出
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync("/tmp/complex-test.json", "utf8"));
const events = Array.isArray(raw) ? raw : (raw.events || raw.log || []);
if (!Array.isArray(events)) {
  console.log("RAW KEYS:", Object.keys(raw));
  console.log("RAW SAMPLE:", JSON.stringify(raw).slice(0, 400));
  process.exit(1);
}

const kinds = {};
for (const e of events) kinds[e.name] = (kinds[e.name] || 0) + 1;

// 工具調用序列（agent 的 tool.invoke）
const invokes = events.filter((e) => e.name === "tool.invoke");
const invokeSeq = invokes.map((e) => {
  const d = e.data || {};
  const args = d.arguments || d.args || d.input || d.parameters || {};
  return `${d.tool || d.name || "?"} :: ${JSON.stringify(args).slice(0, 220)}`;
});

// 節點事件原始 data
const nodeEvents = events.filter((e) => e.name === "canvas.node.created" || e.name === "canvas.node.connected");
const nodeDetails = nodeEvents.map((e) => `${e.name} :: ${JSON.stringify(e.data).slice(0, 250)}`);

// tool.result 摘要（看 workflow_generate 回包）
const results = events.filter((e) => e.name === "tool.result");
const resultSummaries = results.map((e) => JSON.stringify((e.data || {})).slice(0, 200));

// 錯誤事件
const errors = events.filter((e) => (e.name || "").includes("error"));

// 用戶/助手對話
const chats = events.filter((e) => e.name === "session.chat" || (e.name || "").includes("message") || (e.name || "").includes("chat"));

const out = {
  totalEvents: events.length,
  kinds,
  invokeCount: invokes.length,
  invokeSeq,
  nodeDetails,
  resultSummaries,
  errorEvents: errors.slice(0, 5).map((e) => JSON.stringify(e).slice(0, 150)),
  chatCount: chats.length,
};
fs.writeFileSync(".dsh-ssh/analysis.json", JSON.stringify(out, null, 1));
console.log("ok invokes=" + invokes.length + " nodes=" + nodeDetails.length);
