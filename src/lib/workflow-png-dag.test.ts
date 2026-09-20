// workflow-png DAG 端到端測試：renderWorkflowDagPng 回傳的 buffer 真的是 PNG
// （magic bytes 89 50 4E 47）、size > 0，且 sharp 讀得回來。
//
// 為什麼獨立一支而非塞進 workflow-png.test.ts：那支是「零依賴 trailing data 格式」
// 的測試，本支會拉起原生模組 sharp，放一起會讓零依賴測試也要吃原生模組。
//
// 注意：測試 callback 必須 async（tsx 在 CJS 模式下不支援 top-level await）。
import test from "node:test";
import assert from "node:assert/strict";

import { embedWorkflowIntoPng, extractWorkflowFromPng } from "./workflow-png";
import { renderWorkflowDagPng } from "./workflow-png";
import type { DagConnectionInput, DagNodeInput } from "./dag-renderer";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function assertPngMagic(buffer: Buffer): void {
  assert.ok(buffer.length > 8, `buffer 太小：${buffer.length} bytes`);
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    assert.equal(buffer[i], PNG_MAGIC[i], `PNG magic byte #${i} 不符`);
  }
}

const nodes: DagNodeInput[] = [
  { id: "prompt", role: "prompt", kind: "text", title: "產品文案" },
  { id: "hero", role: "hero", kind: "image", title: "主視覺", status: "succeeded", costCoins: 3 },
  { id: "clip", role: "clip", kind: "video", title: "動態版本", status: "failed", error: "upstream 502" },
];
const connections: DagConnectionInput[] = [
  { from: "prompt", to: "hero" },
  { from: "hero", to: "clip" },
];

test("renderWorkflowDagPng 回傳真 PNG（含 3 節點 2 連線與 failed 節點）", async () => {
  const buffer = await renderWorkflowDagPng(nodes, connections, { width: 640, height: 400 });

  assert.ok(buffer.length > 0, "size 必須 > 0");
  assertPngMagic(buffer);
  // PNG 尾端必須有 IEND chunk（完整檔案，不是被截斷的串流）
  assert.equal(buffer.subarray(buffer.length - 8, buffer.length - 4).toString("ascii"), "IEND");
});

test("renderWorkflowDagPng 空節點陣列仍產出合法 PNG", async () => {
  const buffer = await renderWorkflowDagPng([], []);
  assertPngMagic(buffer);
  assert.ok(buffer.length > 0);
});

test("renderWorkflowDagPng 單節點無連線仍產出合法 PNG", async () => {
  const buffer = await renderWorkflowDagPng([nodes[0] as DagNodeInput], []);
  assertPngMagic(buffer);
  assert.ok(buffer.length > 0);
});

test("renderWorkflowDagPng 產物可被當作底圖再嵌入 workflow JSON（兩條出口可組合）", async () => {
  const png = await renderWorkflowDagPng(nodes, connections);
  const workflow = JSON.stringify({ nodes: nodes.map((n) => n.role), version: 1 });
  const embedded = embedWorkflowIntoPng(new Uint8Array(png), workflow);

  assertPngMagic(Buffer.from(embedded));
  assert.equal(extractWorkflowFromPng(embedded), workflow, "嵌入後必須原樣取回");
});
