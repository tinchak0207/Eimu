// 分镜内容变更 → 旧关联媒体失效（W2）行为测试。
//
// 全部是**真函式行为断言**：真算失效键、真把它套到 metadata 上、再看**实际存活的关联**
// 是哪几个——不含源码字串扫描（那种只算变更探针，不计入已验证）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearShotMediaLinks,
  invalidateShotMediaLinksFromPatch,
  invalidatedShotMediaLinks,
  SHOT_MEDIA_LINK_KEYS,
  type StoryboardShotMediaView,
} from "./storyboard-invalidation";

/** 一颗分镜节点的媒体相关 metadata：画面内容在 `storyboardShot`（21 栏），
 * 画师 prompt／旁白／三个关联键在顶层。所有关联都有值＝「这一格已备妥媒体」。
 */
function shotMeta(over: StoryboardShotMediaView = {}): StoryboardShotMediaView {
  return {
    storyboardShot: {
      shotNumber: "001",
      visualDescription: "wide establishing shot",
      dialogue: "hello there",
      shotSize: "WS",
    },
    prompt: "painter prompt v1",
    narration: "narration v1",
    shotCandidates: { items: [{ id: "c1", prompt: "candidate prompt" }], selectedId: "c1" },
    dialogueAudioId: "dlg-audio-1",
    narrationAudioId: "nar-audio-1",
    audioAnchorId: "anchor-1",
    ...over,
  };
}

test("改 dialogue：dialogueAudioId 被清，未变更的关联（narrationAudioId／shotCandidates）留著", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = { storyboardShot: { dialogue: "hello there!" } };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], ["dialogueAudioId", "audioAnchorId"]);

  const after = clearShotMediaLinks(before, keys);
  // 真的清掉了台词配音关联
  assert.ok(!("dialogueAudioId" in after));
  // 未变更的关联一个都不能被清（防过度失效）
  assert.equal(after.narrationAudioId, "nar-audio-1");
  assert.equal(after.shotCandidates, before.shotCandidates);
  // 画面没改 → 影像关联不动
  assert.ok("shotCandidates" in after);
});

test("改 narration：narrationAudioId 被清，dialogueAudioId 与 shotCandidates 留著", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = { narration: "narration v2" };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.ok(keys.includes("narrationAudioId"));

  const after = clearShotMediaLinks(before, keys);
  assert.ok(!("narrationAudioId" in after));
  // 台词没改 → 台词配音关联必须还在（关键反例）
  assert.equal(after.dialogueAudioId, "dlg-audio-1");
  assert.ok("shotCandidates" in after);
});

test("未变更的关联不得被清：同值重送的 patch → 空集，全部关联原封不动", () => {
  const before = shotMeta();
  // dialogue 与 before 完全相同 ＝ 未变更（照对手 changed 的「值真的不同」判据）
  const patch: StoryboardShotMediaView = { storyboardShot: { dialogue: "hello there" } };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], []);

  const after = clearShotMediaLinks(before, keys);
  for (const key of SHOT_MEDIA_LINK_KEYS) {
    assert.ok(key in after, `${key} 不该被清`);
  }
  assert.equal(after.dialogueAudioId, "dlg-audio-1");
  assert.equal(after.narrationAudioId, "nar-audio-1");
  assert.equal(after.audioAnchorId, "anchor-1");
  assert.equal(after.shotCandidates, before.shotCandidates);
});

test("只改 shotSize 这类不影响媒体的栏位：任何关联都不被清", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = { storyboardShot: { shotSize: "CU" } };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], []);

  const after = clearShotMediaLinks(before, keys);
  for (const key of SHOT_MEDIA_LINK_KEYS) {
    assert.ok(key in after, `${key} 不该被清`);
  }
});

test("改 visualDescription：影像关联（shotCandidates）失效，音频关联全留", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = {
    storyboardShot: { visualDescription: "close-up on the hand" },
  };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], ["shotCandidates"]);

  const after = clearShotMediaLinks(before, keys);
  assert.ok(!("shotCandidates" in after));
  assert.equal(after.dialogueAudioId, "dlg-audio-1");
  assert.equal(after.narrationAudioId, "nar-audio-1");
  assert.equal(after.audioAnchorId, "anchor-1");
});

test("改画师 prompt（节点 metadata.prompt）：影像关联失效", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = { prompt: "painter prompt v2" };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], ["shotCandidates"]);
});

test("patch 显式带新 dialogueAudioId：该键不被清（让路给明确绑定），audioAnchorId 仍失效", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = {
    storyboardShot: { dialogue: "hello there!" },
    dialogueAudioId: "dlg-audio-2", // 呼叫端明确要换新配音
  };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], ["audioAnchorId"]);
  assert.ok(!keys.includes("dialogueAudioId"));
});

test("空 patch／undefined patch：空集（没有内容变更就没有失效）", () => {
  const before = shotMeta();
  assert.deepEqual([...invalidatedShotMediaLinks(before, {})], []);
  assert.deepEqual([...invalidatedShotMediaLinks(before, undefined)], []);
  assert.deepEqual([...invalidatedShotMediaLinks(undefined, {})], []);
});

test("清关联是纯函式：回新物件、不改输入、未变更时等值", () => {
  const before = shotMeta();
  const keys = invalidatedShotMediaLinks(before, { storyboardShot: { dialogue: "changed" } });
  const after = clearShotMediaLinks(before, keys);

  assert.notEqual(after, before);
  // 输入没被突变
  assert.equal(before.dialogueAudioId, "dlg-audio-1");
  assert.equal(before.audioAnchorId, "anchor-1");
  // 未失效的键逐字保留
  assert.equal(after.storyboardShot, before.storyboardShot);
  assert.equal(after.prompt, "painter prompt v1");
});

test("摊平形状（内容栏在顶层）与巢状 storyboardShot 同语义", () => {
  const nested = shotMeta();
  const flat: StoryboardShotMediaView = {
    dialogue: "hello there",
    narration: "narration v1",
    dialogueAudioId: "dlg-audio-1",
    narrationAudioId: "nar-audio-1",
    audioAnchorId: "anchor-1",
  };

  const nestedKeys = invalidatedShotMediaLinks(nested, { storyboardShot: { dialogue: "x" } });
  const flatKeys = invalidatedShotMediaLinks(flat, { dialogue: "x" });
  assert.deepEqual([...nestedKeys], [...flatKeys]);
});

test("invalidateShotMediaLinksFromPatch：一次算出失效后的 metadata", () => {
  const before = shotMeta();
  const after = invalidateShotMediaLinksFromPatch(before, { narration: "narration v2" });

  assert.ok(!("narrationAudioId" in after));
  assert.ok(!("audioAnchorId" in after));
  assert.equal(after.dialogueAudioId, "dlg-audio-1");
  assert.ok("shotCandidates" in after);
  // 输入不动
  assert.equal(before.narrationAudioId, "nar-audio-1");
});