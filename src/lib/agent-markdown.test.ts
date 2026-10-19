// agent-markdown 解析层回归锁（罪状 3/9）：表格/粗体/列表/代码块必须解析出
// 结构化块；图片直链（含 GFM 裸 URL 自动链接）必须转成 img span；原始 HTML
// 必须被丢弃（XSS 面为零）。渲染层（AgentMarkdown.tsx）不在此测——纯函数层
// 保证数据形状即可。
import test from "node:test";
import assert from "node:assert/strict";

import { isAudioUrl, isImageUrl, parseAgentMarkdown } from "./agent-markdown";

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

test("影片/音频直链（含裸 URL）转成 video/audio span，不留裸链接", () => {
  const v = JSON.stringify(parseAgentMarkdown("S02 预览：https://store.eimu.dev/image-data/files/generation/jobs/a58c/000-b9.mp4"));
  assert.match(v, /"k":"video"/);
  assert.doesNotMatch(v, /"k":"link"/);
  const a = JSON.stringify(parseAgentMarkdown("[成曲](https://store.eimu.dev/uploads/x.m4a)"));
  assert.match(a, /"k":"audio"/);
});

test("平台参考图目录（无扩展名）补判为图片，且只有精确前缀才命中", () => {
  // generation/references/ 三个写入点落盘前都过 validateImageBuffer => 目录只存图片。
  const bare = "https://store.eimu.dev/image-data/files/generation/references/9f2c1d3e4b5a6978";
  assert.equal(isImageUrl(bare), true);
  const imgs = parseAgentMarkdown(`看这张 ${bare}`)[0];
  assert.ok(imgs.type === "p");
  assert.deepEqual(imgs.children.map((s) => s.k), ["text", "img"]);
  // 同形但换主机：不认（防把任意站点的 /files/ 当图片）。
  assert.equal(isImageUrl("https://evil.example/image-data/files/generation/references/9f2c1d3e4b5a6978"), false);
  // 同主机但目录是图影混居的 jobs：不认（见下一条歧义用例）。
  assert.equal(isImageUrl("https://store.eimu.dev/image-data/files/generation/jobs/dd1869c0/000-b040b36747ec"), false);
});

test("平台音频目录（无扩展名）补判为音频：music-gen 与 /agent/v1/audio/", () => {
  assert.equal(isAudioUrl("https://store.eimu.dev/image-data/files/uploads/music-gen-1727000000"), true);
  assert.equal(isAudioUrl("https://store.eimu.dev/agent/v1/audio/tts_mukadd47_ugkpykpi"), true);
  const a = JSON.stringify(parseAgentMarkdown("成曲 https://store.eimu.dev/agent/v1/audio/tts_mukadd47_ugkpykpi"));
  assert.match(a, /"k":"audio"/);
  assert.doesNotMatch(a, /"k":"link"/);
});

test("混居/非媒体形状（歧义）一律留裸链接，不画媒体卡", () => {
  // generation/jobs：同目录有 png/webp 也有 mp4（artifact-service.ts:454），无法由路径判型。
  // uploads/media-*：网关同端点收 image/video/audio 三类（media-internal-routes.ts:80）。
  // agent-batch3/：实测同目录有 .png 与 .wav，且无稳定命名契约。
  // /v1/images/<id>/result：默认回 JSON 且须 bearer 金钥（<img> 送不出 Authorization）。
  const ambiguous = [
    "https://store.eimu.dev/image-data/files/generation/jobs/dd1869c0-fa54-48d8-8e83-65b536cec6c2/000-b040b36747ec",
    "https://store.eimu.dev/image-data/files/uploads/media-1790874887852-3m62z4",
    "https://store.eimu.dev/image-data/files/agent-batch3/amx-landscape_169-1790873310155-8ec57e",
    "https://image.eimu.dev/v1/images/abc/result",
  ];
  for (const url of ambiguous) {
    assert.equal(isImageUrl(url), false, url);
    assert.equal(isAudioUrl(url), false, url);
    const flat = JSON.stringify(parseAgentMarkdown(`交付：${url}`));
    assert.match(flat, /"k":"link"/, url);
    assert.doesNotMatch(flat, /"k":"img"|"k":"video"|"k":"audio"/, url);
  }
});
