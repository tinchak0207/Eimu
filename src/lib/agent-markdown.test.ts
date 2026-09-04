// agent-markdown 解析层回归锁（罪状 3/9）：表格/粗体/列表/代码块必须解析出
// 结构化块；图片直链（含 GFM 裸 URL 自动链接）必须转成 img span；原始 HTML
// 必须被丢弃（XSS 面为零）。渲染层（AgentMarkdown.tsx）不在此测——纯函数层
// 保证数据形状即可。
import test from "node:test";
import assert from "node:assert/strict";

import { isImageUrl, parseAgentMarkdown } from "./agent-markdown";

test("table: 模型对比表解析成 table 块（罪状 3 主诉）", () => {
  const blocks = parseAgentMarkdown(
    "| 模型 | 单价 |\n|---|---|\n| gpt-image-2 | 6 币 |\n| image-5-pro | 0.5 币 |",
  );
  const table = blocks.find((b) => b.type === "table");
  assert.ok(table && table.type === "table");
  assert.equal(table.head.length, 2);
  assert.equal(table.rows.length, 2);
  const cell = table.rows[0][0][0];
  assert.equal(cell.k, "text");
  assert.equal(cell.k === "text" && cell.text, "gpt-image-2");
});

test("inline: 粗体 / 行内代码 / 代码块 / 列表", () => {
  const blocks = parseAgentMarkdown("这是**重点**和 `task_123` 路径");
  const p = blocks[0];
  assert.ok(p.type === "p");
  assert.deepEqual(
    p.children.map((s) => s.k),
    ["text", "strong", "text", "code", "text"],
  );

  const code = parseAgentMarkdown("```js\nlet a = 1;\n```");
  assert.ok(code[0].type === "code");
  assert.equal(code[0].type === "code" && code[0].lang, "js");
  assert.match(code[0].type === "code" && code[0].text, /let a = 1;/);

  const list = parseAgentMarkdown("- 第一\n- 第二\n1. 甲\n2. 乙");
  const ul = list.find((b) => b.type === "list" && !b.ordered);
  const ol = list.find((b) => b.type === "list" && b.ordered);
  assert.ok(ul && ul.type === "list" && ul.items.length === 2);
  assert.ok(ol && ol.type === "list" && ol.items.length === 2);
});

test("image url: 图片直链转 img span（罪状 9），裸 URL 由 GFM autolink 接住", () => {
  const blocks = parseAgentMarkdown(
    "看这张 https://fakesite.example/out/a.png 和 ![图](https://fakesite.example/out/b.jpg)",
  );
  const p = blocks[0];
  assert.ok(p.type === "p");
  const imgs = p.children.filter((s) => s.k === "img");
  assert.equal(imgs.length, 2);
  assert.ok(imgs.every((s) => s.k === "img" && /^https:\/\/fakesite\.example\/out\//.test(s.src)));
});

test("isImageUrl: 只认 http(s) + 图片扩展名", () => {
  assert.equal(isImageUrl("https://x.example/a.png"), true);
  assert.equal(isImageUrl("https://x.example/a.webp?token=1"), true);
  assert.equal(isImageUrl("https://x.example/page"), false);
  assert.equal(isImageUrl("javascript:alert(1).png"), false);
  assert.equal(isImageUrl("/relative/a.png"), false);
});

test("raw html 被丢弃，不进 DOM", () => {
  const blocks = parseAgentMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>正常文字');
  const flat = JSON.stringify(blocks);
  assert.doesNotMatch(flat, /script/);
  assert.match(flat, /正常文字/);
});

test("解析失败退回纯文本段，不吞内容", () => {
  const blocks = parseAgentMarkdown("just text");
  assert.equal(blocks.length >= 1, true);
  assert.match(JSON.stringify(blocks), /just text/);
});
