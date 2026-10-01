// 分鏡內容變更 → 舊關聯媒體失效（W2）行為測試。
//
// 全部是**真函式行為斷言**：真算失效鍵、真把它套到 metadata 上、再看**實際存活的關聯**
// 是哪幾個——不含源碼字串掃描（那種只算變更探針，不計入已驗證）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearShotMediaLinks,
  invalidateShotMediaLinksFromPatch,
  invalidatedShotMediaLinks,
  SHOT_MEDIA_LINK_KEYS,
  type StoryboardShotMediaView,
} from "./storyboard-invalidation";

/** 一顆分鏡節點的媒體相關 metadata：畫面內容在 `storyboardShot`（21 欄），
 * 畫師 prompt／旁白／三個關聯鍵在頂層。所有關聯都有值＝「這一格已備妥媒體」。
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

test("改 dialogue：dialogueAudioId 被清，未變更的關聯（narrationAudioId／shotCandidates）留著", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = { storyboardShot: { dialogue: "hello there!" } };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], ["dialogueAudioId", "audioAnchorId"]);

  const after = clearShotMediaLinks(before, keys);
  // 真的清掉了台詞配音關聯
  assert.ok(!("dialogueAudioId" in after));
  // 未變更的關聯一個都不能被清（防過度失效）
  assert.equal(after.narrationAudioId, "nar-audio-1");
  assert.equal(after.shotCandidates, before.shotCandidates);
  // 畫面沒改 → 影像關聯不動
  assert.ok("shotCandidates" in after);
});

test("改 narration：narrationAudioId 被清，dialogueAudioId 與 shotCandidates 留著", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = { narration: "narration v2" };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.ok(keys.includes("narrationAudioId"));

  const after = clearShotMediaLinks(before, keys);
  assert.ok(!("narrationAudioId" in after));
  // 台詞沒改 → 台詞配音關聯必須還在（關鍵反例）
  assert.equal(after.dialogueAudioId, "dlg-audio-1");
  assert.ok("shotCandidates" in after);
});

test("未變更的關聯不得被清：同值重送的 patch → 空集，全部關聯原封不動", () => {
  const before = shotMeta();
  // dialogue 與 before 完全相同 ＝ 未變更（照對手 changed 的「值真的不同」判據）
  const patch: StoryboardShotMediaView = { storyboardShot: { dialogue: "hello there" } };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], []);

  const after = clearShotMediaLinks(before, keys);
  for (const key of SHOT_MEDIA_LINK_KEYS) {
    assert.ok(key in after, `${key} 不該被清`);
  }
  assert.equal(after.dialogueAudioId, "dlg-audio-1");
  assert.equal(after.narrationAudioId, "nar-audio-1");
  assert.equal(after.audioAnchorId, "anchor-1");
  assert.equal(after.shotCandidates, before.shotCandidates);
});

test("只改 shotSize 這類不影響媒體的欄位：任何關聯都不被清", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = { storyboardShot: { shotSize: "CU" } };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], []);

  const after = clearShotMediaLinks(before, keys);
  for (const key of SHOT_MEDIA_LINK_KEYS) {
    assert.ok(key in after, `${key} 不該被清`);
  }
});

test("改 visualDescription：影像關聯（shotCandidates）失效，音頻關聯全留", () => {
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

test("改畫師 prompt（節點 metadata.prompt）：影像關聯失效", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = { prompt: "painter prompt v2" };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], ["shotCandidates"]);
});

test("patch 顯式帶新 dialogueAudioId：該鍵不被清（讓路給明確綁定），audioAnchorId 仍失效", () => {
  const before = shotMeta();
  const patch: StoryboardShotMediaView = {
    storyboardShot: { dialogue: "hello there!" },
    dialogueAudioId: "dlg-audio-2", // 呼叫端明確要換新配音
  };

  const keys = invalidatedShotMediaLinks(before, patch);
  assert.deepEqual([...keys], ["audioAnchorId"]);
  assert.ok(!keys.includes("dialogueAudioId"));
});

test("空 patch／undefined patch：空集（沒有內容變更就沒有失效）", () => {
  const before = shotMeta();
  assert.deepEqual([...invalidatedShotMediaLinks(before, {})], []);
  assert.deepEqual([...invalidatedShotMediaLinks(before, undefined)], []);
  assert.deepEqual([...invalidatedShotMediaLinks(undefined, {})], []);
});

test("清關聯是純函式：回新物件、不改輸入、未變更時等值", () => {
  const before = shotMeta();
  const keys = invalidatedShotMediaLinks(before, { storyboardShot: { dialogue: "changed" } });
  const after = clearShotMediaLinks(before, keys);

  assert.notEqual(after, before);
  // 輸入沒被突變
  assert.equal(before.dialogueAudioId, "dlg-audio-1");
  assert.equal(before.audioAnchorId, "anchor-1");
  // 未失效的鍵逐字保留
  assert.equal(after.storyboardShot, before.storyboardShot);
  assert.equal(after.prompt, "painter prompt v1");
});

test("攤平形狀（內容欄在頂層）與巢狀 storyboardShot 同語義", () => {
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

test("invalidateShotMediaLinksFromPatch：一次算出失效後的 metadata", () => {
  const before = shotMeta();
  const after = invalidateShotMediaLinksFromPatch(before, { narration: "narration v2" });

  assert.ok(!("narrationAudioId" in after));
  assert.ok(!("audioAnchorId" in after));
  assert.equal(after.dialogueAudioId, "dlg-audio-1");
  assert.ok("shotCandidates" in after);
  // 輸入不動
  assert.equal(before.narrationAudioId, "nar-audio-1");
});