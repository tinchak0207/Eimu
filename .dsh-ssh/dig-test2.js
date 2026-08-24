// 深挖第二次測試：找錯誤、tool 可用性、最後事件
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync("/tmp/complex-test2.json", "utf8"));
const events = Array.isArray(raw) ? raw : (raw.events || []);
const out = [];
for (const e of events) {
  const s = JSON.stringify(e);
  if (/error|Error|fail|abort|exceed|limit/i.test(s)) out.push(s.slice(0, 300));
}
console.log("error-ish events:", out.length);
out.slice(0, 10).forEach((s) => console.log(" ", s));
// 最後 5 個事件
console.log("--- last 5 events:");
events.slice(-5).forEach((e) => console.log(" ", e.name, JSON.stringify(e.data || {}).slice(0, 150)));
// reasoning 最後一段文本
const reas = events.filter((e) => e.name === "reasoning.delta");
const lastText = reas.slice(-8).map((e) => (e.data && (e.data.text || e.data.delta || "")) || "").join("");
console.log("--- last reasoning text:", lastText.slice(-600));
