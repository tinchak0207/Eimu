// dag-renderer 测试：SVG 结构合法性（开头 <svg、含全部 title、含箭头 marker、
// failed 红框、空图与单节点不炸）。风格对齐 src/lib/workflow-png.test.ts
// （node:test + assert/strict）。
//
// 注意：这些测试只验 SVG 字串本身；PNG 端到端（sharp）在
// src/lib/workflow-png-dag.test.ts，两者故意分开，让本档保持零原生依赖。
import test from "node:test";
import assert from "node:assert/strict";

import type { DagNodeInput } from "./dag-renderer";
import { renderDagSvg } from "./dag-renderer";

function node(overrides: Partial<DagNodeInput> & { id: string }): DagNodeInput {
  return { role: overrides.id, kind: "image", title: `节点 ${overrides.id}`, ...overrides };
}

test("正常 DAG（3 节点 2 连线）→ SVG 开头是 <svg、含所有 title、含箭头 marker", () => {
  const svg = renderDagSvg(
    [node({ id: "a" }), node({ id: "b", kind: "video" }), node({ id: "c", kind: "text" })],
    [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  );

  assert.ok(svg.trimStart().startsWith("<svg"), "开头必须是 <svg");
  assert.ok(svg.endsWith("</svg>"), "结尾必须是 </svg>");
  for (const id of ["a", "b", "c"]) {
    assert.ok(svg.includes(`节点 ${id}`), `必须含 title「节点 ${id}」`);
  }
  assert.ok(svg.includes("marker-end"), "连线必须带 marker-end");
  assert.ok(svg.includes('id="dag-arrow"'), "必须宣告箭头 marker");
  // 两条连线 = 两个 marker-end 引用
  assert.equal((svg.match(/marker-end/g) ?? []).length, 2);});

test("节点依 kind 上色（顶部色条 + 标签成对）", () => {
  const svg = renderDagSvg(
    [node({ id: "img", kind: "image" }), node({ id: "vid", kind: "video" })],
    [{ from: "img", to: "vid" }],
  );
  // image/video 都是「产出」类，色相分开落在站内画布规范的绿／紫
  assert.ok(svg.includes('fill="#00b578"'), "image 应落在绿色系");
  assert.ok(svg.includes('fill="#722ed1"'), "video 应落在紫色系");
  // 标签徽章：底色与文字色成对
  assert.ok(svg.includes('fill="#e6fffb"'), "image 标签底色");
  assert.ok(svg.includes('fill="#f9f0ff"'), "video 标签底色");
});

test("卡片带顶部色条与标签（缩图可辨识度）", () => {
  const svg = renderDagSvg([node({ id: "cfg", kind: "config" })], []);
  assert.ok(svg.includes('fill="#1677ff"'), "config 顶部色条＝工具蓝");
  assert.ok(svg.includes("配置"), "config 标签文字＝配置");
  assert.ok(svg.includes('width="220"'), "卡片宽度＝站内画布节点宽");
  assert.ok(svg.includes('id="dag-grid"'), "背景需有网格点阵");
});

test("I/O 描述行：连线关系必须进节点卡（↳ 来源 / → 目标）", () => {
  const svg = renderDagSvg(
    [node({ id: "a", role: "garment_extract" }), node({ id: "b", role: "asset_out" })],
    [{ from: "a", to: "b" }],
  );
  assert.ok(svg.includes("↳"), "下游节点要有输入来源行");
  assert.ok(svg.includes("→"), "上游节点要有产出目标行");
  assert.ok(svg.includes("garment extract"), "role 应可读化（底线转空白）");
});

test("空节点阵列 → 不炸，回传最小合法 SVG", () => {
  const svg = renderDagSvg([], []);
  assert.ok(svg.trimStart().startsWith("<svg"), "空图也要是合法 SVG");
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes("暂无节点"), "空图要有提示文字");
});

test("单节点无连线 → 不炸，节点有座标", () => {
  const svg = renderDagSvg([node({ id: "solo" })], []);
  assert.ok(svg.trimStart().startsWith("<svg"));
  assert.ok(svg.includes("节点 solo"));
});

test("status:failed → SVG 含红色边框色 #f53f3f（light theme）", () => {
  const svg = renderDagSvg(
    [node({ id: "bad", status: "failed" }), node({ id: "ok", status: "succeeded" })],
    [{ from: "ok", to: "bad" }],
  );
  assert.ok(svg.includes('stroke="#f53f3f"'), "failed 节点要有红框");
});

test("costCoins → 右下角显示币数（含 0 也要显示）", () => {
  const svg = renderDagSvg(
    [node({ id: "paid", costCoins: 3 }), node({ id: "free", costCoins: 0 })],
    [{ from: "paid", to: "free" }],
  );
  assert.ok(svg.includes("3 币"), "整数币数直接显示");
  assert.ok(svg.includes("0 币"), "0 币也是事实，要显示");
});

test("costCoins 小数 → 留一位小数", () => {
  const svg = renderDagSvg([node({ id: "x", costCoins: 3.14159 })], []);
  assert.ok(svg.includes("3.1 币"));
});

test("error 栏位被转义，不破坏 SVG 结构", () => {
  const svg = renderDagSvg(
    [node({ id: "esc", title: 'a<b>&"c' })],
    [],
  );
  assert.ok(svg.includes("a&lt;b&gt;&amp;&quot;c"), "标题必须 XML 转义");
  assert.ok(svg.trimStart().startsWith("<svg"), "转义不得破坏外壳");
});

test("连线指向不存在的节点 → 该边略过，不炸", () => {
  const svg = renderDagSvg([node({ id: "a" })], [{ from: "a", to: "ghost" }]);
  assert.ok(svg.trimStart().startsWith("<svg"));
  assert.equal((svg.match(/marker-end/g) ?? []).length, 0, "孤儿边不得画出");
});

test("重复边去重", () => {
  const svg = renderDagSvg(
    [node({ id: "a" }), node({ id: "b" })],
    [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
    ],
  );
  assert.equal((svg.match(/marker-end/g) ?? []).length, 1);
});

test("节点多于预设画布 → viewBox 依实际范围放大，不硬切", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
  const nodes = ids.map((id) => node({ id }));
  const connections = ids.slice(0, -1).map((id, i) => ({ from: id, to: ids[i + 1] as string }));
  const svg = renderDagSvg(nodes, connections, { width: 640, height: 400 });
  const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(m, "必须有 viewBox");
  const w = Number(m?.[1]);
  const h = Number(m?.[2]);
  assert.ok(w > 640, `12 个 LR 节点宽度必超过 640，实得 ${w}`);
  assert.ok(h >= 400, "高度至少 400");
});

test("dark theme → 用深色背景", () => {
  const svg = renderDagSvg([node({ id: "d" })], [], { theme: "dark" });
  assert.ok(svg.includes('fill="#0f172a"'), "dark 背景色");
  const lightSvg = renderDagSvg([node({ id: "d" })], [], { theme: "light" });
  assert.ok(lightSvg.includes('fill="#ffffff"'), "light 背景色");
});
