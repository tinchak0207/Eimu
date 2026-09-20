// dag-renderer 測試：SVG 結構合法性（開頭 <svg、含全部 title、含箭頭 marker、
// failed 紅框、空圖與單節點不炸）。風格對齊 src/lib/workflow-png.test.ts
// （node:test + assert/strict）。
//
// 注意：這些測試只驗 SVG 字串本身；PNG 端到端（sharp）在
// src/lib/workflow-png-dag.test.ts，兩者故意分開，讓本檔保持零原生依賴。
import test from "node:test";
import assert from "node:assert/strict";

import type { DagNodeInput } from "./dag-renderer";
import { renderDagSvg } from "./dag-renderer";

function node(overrides: Partial<DagNodeInput> & { id: string }): DagNodeInput {
  return { role: overrides.id, kind: "image", title: `節點 ${overrides.id}`, ...overrides };
}

test("正常 DAG（3 節點 2 連線）→ SVG 開頭是 <svg、含所有 title、含箭頭 marker", () => {
  const svg = renderDagSvg(
    [node({ id: "a" }), node({ id: "b", kind: "video" }), node({ id: "c", kind: "text" })],
    [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  );

  assert.ok(svg.trimStart().startsWith("<svg"), "開頭必須是 <svg");
  assert.ok(svg.endsWith("</svg>"), "結尾必須是 </svg>");
  for (const id of ["a", "b", "c"]) {
    assert.ok(svg.includes(`節點 ${id}`), `必須含 title「節點 ${id}」`);
  }
  assert.ok(svg.includes("marker-end"), "連線必須帶 marker-end");
  assert.ok(svg.includes('id="dag-arrow"'), "必須宣告箭頭 marker");
  // 兩條連線 = 兩個 marker-end 引用
  assert.equal((svg.match(/marker-end/g) ?? []).length, 2);});

test("節點依 kind 上色（頂部色條 + 標籤成對）", () => {
  const svg = renderDagSvg(
    [node({ id: "img", kind: "image" }), node({ id: "vid", kind: "video" })],
    [{ from: "img", to: "vid" }],
  );
  // image/video 都是「產出」類，色相分開落在站內畫布規範的綠／紫
  assert.ok(svg.includes('fill="#00b578"'), "image 應落在綠色系");
  assert.ok(svg.includes('fill="#722ed1"'), "video 應落在紫色系");
  // 標籤徽章：底色與文字色成對
  assert.ok(svg.includes('fill="#e6fffb"'), "image 標籤底色");
  assert.ok(svg.includes('fill="#f9f0ff"'), "video 標籤底色");
});

test("卡片帶頂部色條與標籤（縮圖可辨識度）", () => {
  const svg = renderDagSvg([node({ id: "cfg", kind: "config" })], []);
  assert.ok(svg.includes('fill="#1677ff"'), "config 頂部色條＝工具藍");
  assert.ok(svg.includes("配置"), "config 標籤文字＝配置");
  assert.ok(svg.includes('width="220"'), "卡片寬度＝站內畫布節點寬");
  assert.ok(svg.includes('id="dag-grid"'), "背景需有網格點陣");
});

test("I/O 描述行：連線關係必須進節點卡（↳ 來源 / → 目標）", () => {
  const svg = renderDagSvg(
    [node({ id: "a", role: "garment_extract" }), node({ id: "b", role: "asset_out" })],
    [{ from: "a", to: "b" }],
  );
  assert.ok(svg.includes("↳"), "下游節點要有輸入來源行");
  assert.ok(svg.includes("→"), "上游節點要有產出目標行");
  assert.ok(svg.includes("garment extract"), "role 應可讀化（底線轉空白）");
});

test("空節點陣列 → 不炸，回傳最小合法 SVG", () => {
  const svg = renderDagSvg([], []);
  assert.ok(svg.trimStart().startsWith("<svg"), "空圖也要是合法 SVG");
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes("暫無節點"), "空圖要有提示文字");
});

test("單節點無連線 → 不炸，節點有座標", () => {
  const svg = renderDagSvg([node({ id: "solo" })], []);
  assert.ok(svg.trimStart().startsWith("<svg"));
  assert.ok(svg.includes("節點 solo"));
});

test("status:failed → SVG 含紅色邊框色 #f53f3f（light theme）", () => {
  const svg = renderDagSvg(
    [node({ id: "bad", status: "failed" }), node({ id: "ok", status: "succeeded" })],
    [{ from: "ok", to: "bad" }],
  );
  assert.ok(svg.includes('stroke="#f53f3f"'), "failed 節點要有紅框");
});

test("costCoins → 右下角顯示幣數（含 0 也要顯示）", () => {
  const svg = renderDagSvg(
    [node({ id: "paid", costCoins: 3 }), node({ id: "free", costCoins: 0 })],
    [{ from: "paid", to: "free" }],
  );
  assert.ok(svg.includes("3 幣"), "整數幣數直接顯示");
  assert.ok(svg.includes("0 幣"), "0 幣也是事實，要顯示");
});

test("costCoins 小數 → 留一位小數", () => {
  const svg = renderDagSvg([node({ id: "x", costCoins: 3.14159 })], []);
  assert.ok(svg.includes("3.1 幣"));
});

test("error 欄位被轉義，不破壞 SVG 結構", () => {
  const svg = renderDagSvg(
    [node({ id: "esc", title: 'a<b>&"c' })],
    [],
  );
  assert.ok(svg.includes("a&lt;b&gt;&amp;&quot;c"), "標題必須 XML 轉義");
  assert.ok(svg.trimStart().startsWith("<svg"), "轉義不得破壞外殼");
});

test("連線指向不存在的節點 → 該邊略過，不炸", () => {
  const svg = renderDagSvg([node({ id: "a" })], [{ from: "a", to: "ghost" }]);
  assert.ok(svg.trimStart().startsWith("<svg"));
  assert.equal((svg.match(/marker-end/g) ?? []).length, 0, "孤兒邊不得畫出");
});

test("重複邊去重", () => {
  const svg = renderDagSvg(
    [node({ id: "a" }), node({ id: "b" })],
    [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
    ],
  );
  assert.equal((svg.match(/marker-end/g) ?? []).length, 1);
});

test("節點多於預設畫布 → viewBox 依實際範圍放大，不硬切", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
  const nodes = ids.map((id) => node({ id }));
  const connections = ids.slice(0, -1).map((id, i) => ({ from: id, to: ids[i + 1] as string }));
  const svg = renderDagSvg(nodes, connections, { width: 640, height: 400 });
  const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  assert.ok(m, "必須有 viewBox");
  const w = Number(m?.[1]);
  const h = Number(m?.[2]);
  assert.ok(w > 640, `12 個 LR 節點寬度必超過 640，實得 ${w}`);
  assert.ok(h >= 400, "高度至少 400");
});

test("dark theme → 用深色背景", () => {
  const svg = renderDagSvg([node({ id: "d" })], [], { theme: "dark" });
  assert.ok(svg.includes('fill="#0f172a"'), "dark 背景色");
  const lightSvg = renderDagSvg([node({ id: "d" })], [], { theme: "light" });
  assert.ok(lightSvg.includes('fill="#ffffff"'), "light 背景色");
});
