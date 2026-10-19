import assert from "node:assert/strict";
import test from "node:test";
import { parseCanvasProjectSummaries, toCanvasProjectSummaryWire } from "./project-summary.ts";
import { toProjectSummaries } from "../../hooks/canvas/canvas-chat-types.ts";
import type { CanvasProject } from "./types.ts";

const project = (id: string, nodes: number, updatedAt: string): CanvasProject =>
  ({
    id,
    title: `画布 ${id}`,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: `${id}-n${i}`, metadata: { content: "data:image/png;base64,AAAA" } })),
    connections: [],
    viewport: { x: 0, y: 0, k: 1 },
    backgroundMode: "dots",
  }) as unknown as CanvasProject;

test("摘要只带标题/时间/节点数，不带节点本体（内嵌图片不上线）", () => {
  const wire = toCanvasProjectSummaryWire(project("a", 3, "2026-10-01T00:00:00.000Z"));
  assert.deepEqual(wire, { id: "a", title: "画布 a", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", nodeCount: 3 });
  assert.ok(!JSON.stringify(wire).includes("data:image"));
});

test("外部摘要逐项验证：缺 id 的丢弃、缺栏补预设，非阵列回 undefined", () => {
  assert.equal(parseCanvasProjectSummaries({}), undefined);
  assert.deepEqual(parseCanvasProjectSummaries([{ id: "x", nodeCount: "2" }, { title: "no id" }, null]), [
    { id: "x", title: "", createdAt: "", updatedAt: "", nodeCount: 0 },
  ]);
});

test("清单摘要：服务端摘要与全量专案得到同一份结果（滤空画布、新到旧）", () => {
  const full = [project("old", 2, "2026-09-01T00:00:00.000Z"), project("empty", 0, "2026-10-02T00:00:00.000Z"), project("new", 5, "2026-10-01T00:00:00.000Z")];
  const fromFull = toProjectSummaries(full);
  const fromWire = toProjectSummaries(full.map(toCanvasProjectSummaryWire));
  assert.deepEqual(fromWire, fromFull);
  assert.deepEqual(fromFull.map((s) => s.id), ["new", "old"]);
});
