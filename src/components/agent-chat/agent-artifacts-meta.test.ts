// 会话产物元数据（OpenUI Query 工具的真源）：只读会话条目，取不到为空，曲序按会话顺序。
import test from "node:test";
import assert from "node:assert/strict";
import { buildArtifactTools, formatDuration, staticArtifactMeta, type AgentMediaItem } from "./agent-artifacts-context";

const items: AgentMediaItem[] = [
  { kind: "image", id: "i1", seq: 1, url: "https://x/a.png", taskId: "t_img", costCoins: 4, recipe: { model: "flux-pro", size: "1024x1536" } },
  { kind: "audio", id: "a1", seq: 2, url: "https://x/1.m4a", taskId: "t_a1", title: "路灯下的行李", mediaKind: "music" },
  { kind: "audio", id: "a2", seq: 3, url: "https://x/2.m4a", taskId: "t_a2" },
  { kind: "video", id: "v1", seq: 4, url: "https://x/v.mp4" },
];

test("静态元数据：模型/尺寸/扣费/曲序来自条目，缺失为空", () => {
  const img = staticArtifactMeta(items, items[0]);
  assert.equal(img.model, "flux-pro");
  assert.equal(img.size, "1024x1536");
  assert.equal(img.cost, "4 金币");
  assert.equal(img.trackNo, null);
  const a2 = staticArtifactMeta(items, items[2]);
  assert.equal(a2.trackNo, 2);
  assert.equal(a2.title, "");
  assert.equal(a2.cost, "");
  assert.equal(a2.costCoins, null);
  const v = staticArtifactMeta(items, items[3]);
  assert.equal(v.taskId, "");
  assert.equal(v.model, "");
});

test("artifact 工具：不存在的 taskId 返回 found=false 且全部字段为空", async () => {
  const tools = buildArtifactTools(items);
  const miss = (await tools.artifact({ taskId: "task_fake" })) as Record<string, unknown>;
  assert.equal(miss.found, false);
  for (const k of ["model", "resolution", "duration", "cost", "title"]) assert.equal(miss[k], "", k);
  assert.equal(miss.durationSec, null);
  // Node 下无 DOM：实测字段为空，静态字段照常。
  const hit = (await tools.artifact({ taskId: "t_img" })) as Record<string, unknown>;
  assert.equal(hit.found, true);
  assert.equal(hit.model, "flux-pro");
  assert.equal(hit.resolution, "");
  const list = (await tools.artifacts({ kind: "audio" })) as { rows: Array<Record<string, unknown>>; count: number };
  assert.equal(list.count, 2);
  assert.deepEqual(list.rows.map((r) => r.trackNo), [1, 2]);
});

test("时长格式化", () => {
  assert.equal(formatDuration(184.2), "3:04");
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(null), "");
});
