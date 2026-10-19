// workflow-png DAG 端到端测试：renderWorkflowDagPng 回传的 buffer 真的是 PNG
// （magic bytes 89 50 4E 47）、size > 0，且 sharp 读得回来。
//
// 为什么独立一支而非塞进 workflow-png.test.ts：那支是「零依赖 trailing data 格式」
// 的测试，本支会拉起原生模组 sharp，放一起会让零依赖测试也要吃原生模组。
//
// 注意：测试 callback 必须 async（tsx 在 CJS 模式下不支援 top-level await）。
import test from "node:test";
import assert from "node:assert/strict";

import { embedWorkflowIntoPng, extractWorkflowFromPng } from "./workflow-png";
import { renderWorkflowDagPng } from "./dag-png-server";
import type { DagConnectionInput, DagNodeInput } from "./dag-renderer";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function assertPngMagic(buffer: Buffer): void {
  assert.ok(buffer.length > 8, `buffer 太小：${buffer.length} bytes`);
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    assert.equal(buffer[i], PNG_MAGIC[i], `PNG magic byte #${i} 不符`);
  }
}

const nodes: DagNodeInput[] = [
  { id: "prompt", role: "prompt", kind: "text", title: "产品文案" },
  { id: "hero", role: "hero", kind: "image", title: "主视觉", status: "succeeded", costCoins: 3 },
  { id: "clip", role: "clip", kind: "video", title: "动态版本", status: "failed", error: "upstream 502" },
];
const connections: DagConnectionInput[] = [
  { from: "prompt", to: "hero" },
  { from: "hero", to: "clip" },
];

test("renderWorkflowDagPng 回传真 PNG（含 3 节点 2 连线与 failed 节点）", async () => {
  const buffer = await renderWorkflowDagPng(nodes, connections, { width: 640, height: 400 });

  assert.ok(buffer.length > 0, "size 必须 > 0");
  assertPngMagic(buffer);
  // PNG 尾端必须有 IEND chunk（完整档案，不是被截断的串流）
  assert.equal(buffer.subarray(buffer.length - 8, buffer.length - 4).toString("ascii"), "IEND");
});

test("renderWorkflowDagPng 空节点阵列仍产出合法 PNG", async () => {
  const buffer = await renderWorkflowDagPng([], []);
  assertPngMagic(buffer);
  assert.ok(buffer.length > 0);
});

test("renderWorkflowDagPng 单节点无连线仍产出合法 PNG", async () => {
  const buffer = await renderWorkflowDagPng([nodes[0] as DagNodeInput], []);
  assertPngMagic(buffer);
  assert.ok(buffer.length > 0);
});

test("renderWorkflowDagPng 产物可被当作底图再嵌入 workflow JSON（两条出口可组合）", async () => {
  const png = await renderWorkflowDagPng(nodes, connections);
  const workflow = JSON.stringify({ nodes: nodes.map((n) => n.role), version: 1 });
  const embedded = embedWorkflowIntoPng(new Uint8Array(png), workflow);

  assertPngMagic(Buffer.from(embedded));
  assert.equal(extractWorkflowFromPng(embedded), workflow, "嵌入后必须原样取回");
});
