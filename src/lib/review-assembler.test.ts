// 审查页组装器测试：pane 组装 / slug 安全化 / 空 board 容忍。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeReviewPanes,
  groupReviewSections,
  paneTitleFor,
  slugifyForAnchor,
} from "./review-assembler.ts";
import type { SavedShotMeta } from "./boards-store";

function makeShot(overrides: Partial<SavedShotMeta> & { id: string }): SavedShotMeta {
  return {
    id: overrides.id,
    boardId: overrides.boardId ?? "b1",
    name: overrides.name ?? "",
    createdAt: overrides.createdAt ?? Date.now(),
    starred: overrides.starred ?? false,
    modelId: overrides.modelId,
    endpointLabel: overrides.endpointLabel,
    presetLabel: overrides.presetLabel,
    prompt: overrides.prompt,
    imageSize: overrides.imageSize,
  };
}

test("composeReviewPanes 每个 shot 一个 pane，标题与元数据正确映射且保序", () => {
  const shots = [
    makeShot({
      id: "1710000000000-abc123",
      name: "主视觉定稿",
      createdAt: 1710000000000,
      starred: true,
      modelId: "gpt-image-2",
      endpointLabel: "adobe2api",
      presetLabel: "产品图",
      imageSize: "1024x1024",
    }),
    makeShot({
      id: "1710000000001-def456",
      name: "",
      prompt: "一张柔和光线下的护肤品瓶身特写",
      createdAt: 1710000000001,
      modelId: "nano-banana-pro",
    }),
  ];
  const panes = composeReviewPanes(shots);
  assert.equal(panes.length, 2);
  assert.equal(panes[0].shotId, "1710000000000-abc123");
  assert.equal(panes[0].title, "主视觉定稿");
  assert.equal(panes[0].starred, true);
  assert.equal(panes[0].metadata.modelId, "gpt-image-2");
  assert.equal(panes[0].metadata.endpointLabel, "adobe2api");
  assert.equal(panes[0].metadata.presetLabel, "产品图");
  assert.equal(panes[0].metadata.imageSize, "1024x1024");
  // 无 name 时退回 prompt 作标题
  assert.equal(panes[1].title, "一张柔和光线下的护肤品瓶身特写");
  assert.equal(panes[1].metadata.imageSize, undefined);
});

test("标题截断：超长 prompt 按码点截断并加省略号", () => {
  const longPrompt = "光".repeat(60);
  const title = paneTitleFor({ name: "", prompt: longPrompt });
  const chars = Array.from(title);
  assert.equal(chars.length, 29); // 28 字 + 省略号
  assert.ok(title.endsWith("…"));
});

test("slug 安全化：仅保留 [a-z0-9-]，空白/CJK/符号折叠，空结果兜底", () => {
  assert.equal(slugifyForAnchor("1710000000000-abc123"), "1710000000000-abc123");
  assert.equal(slugifyForAnchor("A B/C__d"), "a-b-c-d");
  assert.equal(slugifyForAnchor("  ---  "), "shot");
  assert.equal(slugifyForAnchor("全部是中文"), "shot");
  assert.ok(/^[a-z0-9-]+$/.test(slugifyForAnchor("id with spaces/slashes?")));
});

test("anchorId 唯一：slug 撞名时追加序号，深链 hash 永不歧义", () => {
  const panes = composeReviewPanes([
    makeShot({ id: "a b" }),
    makeShot({ id: "a-b" }),
    makeShot({ id: "a/b" }),
  ]);
  assert.equal(panes[0].anchorId, "pane-a-b");
  assert.equal(panes[1].anchorId, "pane-a-b-2");
  assert.equal(panes[2].anchorId, "pane-a-b-3");
  const ids = new Set(panes.map((p) => p.anchorId));
  assert.equal(ids.size, 3);
});

test("空 board 容忍：空数组、缺 name/prompt、无效 createdAt 都不炸", () => {
  assert.deepEqual(composeReviewPanes([]), []);
  assert.deepEqual(groupReviewSections([]), []);
  const panes = composeReviewPanes([
    makeShot({ id: "x1", name: "", prompt: undefined, createdAt: Number.NaN }),
  ]);
  assert.equal(panes[0].title, "未命名镜头");
  const sections = groupReviewSections(panes);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].label, "未分组");
  assert.equal(sections[0].panes.length, 1);
});

test("导航分组：同日 pane 归同一组，组按首次出现顺序排列", () => {
  const day1 = new Date(2026, 7, 22, 10, 0, 0).getTime();
  const day2 = new Date(2026, 7, 23, 10, 0, 0).getTime();
  const panes = composeReviewPanes([
    makeShot({ id: "s1", name: "a", createdAt: day2 }),
    makeShot({ id: "s2", name: "b", createdAt: day1 }),
    makeShot({ id: "s3", name: "c", createdAt: day2 + 1000 }),
  ]);
  const sections = groupReviewSections(panes);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].label, "2026-08-23");
  assert.equal(sections[0].panes.length, 2);
  assert.equal(sections[1].label, "2026-08-22");
  assert.equal(sections[1].panes[0].title, "b");
});
