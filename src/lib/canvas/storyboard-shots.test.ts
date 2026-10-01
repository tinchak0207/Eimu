// 分鏡級抽卡＋星標＋prompt 回溯＋增刪複製重排（P1-2）行為測試。
//
// 全部是**真函式行為斷言**：真加候選、真星標、真回溯、真移動清單、真往復雙白名單；
// 不含源碼字串掃描（那種只算變更探針）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addShotCandidate,
  bindShotAudioTrack,
  clearShotAudioTrack,
  cloneShotNode,
  deleteShotEntry,
  duplicateShotEntry,
  insertShotEntry,
  MAX_SHOT_CANDIDATE_PROMPT_CHARS,
  moveShotEntry,
  normalizeShotCandidates,
  readShotCandidates,
  removeShotCandidate,
  selectShotCandidate,
  selectedShotCandidate,
  selectedShotCandidatePrompt,
  shotCandidatePrompt,
  shotCandidatesMetadata,
  shotListEntries,
  shotMediaReadiness,
  shotNumberOf,
  SHOT_CANDIDATE_LIMIT,
  shotRerunRequest,
} from "./storyboard-shots";
import { toNodeMetadata } from "./layout";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import { CanvasNodeType } from "./types";
import type { CanvasNode, CanvasNodeMetadata } from "./types";
import type { StoryboardShotCandidateSet } from "./storyboard-shots";

function shotNode(id: string, shotNumber: string, metadata: CanvasNodeMetadata = {}): CanvasNode {
  return {
    id,
    type: CanvasNodeType.Image,
    title: `镜头 ${shotNumber}`,
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: {
      ...metadata,
      storyboardShot: {
        shotNumber,
        scriptContent: "",
        visualDescription: "雨夜码头",
        dialogue: "",
        actionState: "",
        narrativeFunction: "",
        timeOfDay: "",
        eraCoordinate: "",
        dateCoordinate: "",
        weather: "",
        referenceAssets: "",
        shotSize: "",
        cameraAngle: "",
        focalLength: "",
        cameraMovement: "",
        composition: "",
        atmosphere: "",
        colorTone: "",
        lighting: "",
        exposureBlur: "",
        soundEffect: "",
      },
    },
  };
}

/** 真往復：真上行壓縮 → 真還原端清洗。 */
function roundTrip(metadata: CanvasNodeMetadata): CanvasNodeMetadata {
  return toNodeMetadata(compactMetadataForAgent(metadata));
}

function addN(count: number): StoryboardShotCandidateSet {
  let set: StoryboardShotCandidateSet | undefined;
  for (let i = 0; i < count; i += 1) {
    const result = addShotCandidate(set, { id: `c${i + 1}`, prompt: `prompt-${i + 1}` });
    assert.equal(result.accepted, true, `第 ${i + 1} 條候選應被接受`);
    set = result.set;
  }
  assert.ok(set);
  return set;
}

// ─────────────────────────────────────────── ① 抽卡：候選集＋星標

test("抽卡：一分鏡最多 4 條，第 5 條被明確拒絕（不是靜默丟棄）", () => {
  const set = addN(SHOT_CANDIDATE_LIMIT);
  assert.equal(set.items.length, SHOT_CANDIDATE_LIMIT);
  assert.equal(SHOT_CANDIDATE_LIMIT, 4, "D9 逐字：一分鏡 ≤4 條");

  const overflow = addShotCandidate(set, { id: "c5", prompt: "第五條" });
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.reason, "full");
  assert.equal(overflow.set.items.length, 4, "塞不下時集合原樣不動");
});

test("抽卡：缺 prompt／缺 id 的候選整條拒絕（沒有溯源的候選不成立）", () => {
  const noPrompt = addShotCandidate(undefined, { id: "c1", prompt: "   " });
  assert.equal(noPrompt.accepted, false);
  assert.equal(noPrompt.reason, "invalid");
  assert.deepEqual(noPrompt.set.items, []);

  const noId = addShotCandidate(undefined, { prompt: "有 prompt 沒 id" });
  assert.equal(noId.accepted, false);
  assert.equal(noId.reason, "invalid");

  const dup = addShotCandidate(addN(1), { id: "c1", prompt: "重複 id" });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, "duplicate");
});

test("星標：首條自動選定；只有成員能被選中；刪掉星標者回退剩餘第一條", () => {
  const set = addN(3);
  assert.equal(set.selectedId, "c1", "首條自動上星標（一鏡要有採用稿）");

  const toC3 = selectShotCandidate(set, "c3");
  assert.equal(toC3.selected, true);
  assert.equal(toC3.set.selectedId, "c3");
  assert.equal(set.selectedId, "c1", "選星標不動原集合（純函式）");

  const ghost = selectShotCandidate(set, "not-a-member");
  assert.equal(ghost.selected, false);
  assert.equal(ghost.set.selectedId, "c1", "非成員不可選中（不製造懸空星標）");

  const removed = removeShotCandidate(toC3.set, "c3");
  assert.equal(removed.removed, true);
  assert.equal(removed.set.selectedId, "c1", "刪掉星標者回退剩餘第一條");

  const removedOther = removeShotCandidate(toC3.set, "c1");
  assert.equal(removedOther.set.selectedId, "c3", "刪非星標者不動星標");

  let empty = toC3.set;
  for (const item of [...toC3.set.items]) empty = removeShotCandidate(empty, item.id).set;
  assert.deepEqual(empty.items, []);
  assert.equal(empty.selectedId, undefined);
  assert.deepEqual(shotCandidatesMetadata(empty), {}, "候選清空＝省略整個鍵（不寫空殼）");
});

test("星標讀回：selectedShotCandidate 指向星標那一條（真值比對）", () => {
  const set = selectShotCandidate(addN(3), "c2").set;
  const selected = selectedShotCandidate(set);
  assert.equal(selected?.id, "c2");
  assert.equal(selected?.prompt, "prompt-2");
  assert.equal(selectedShotCandidate({ items: [] }), null);
  assert.equal(selectedShotCandidate(undefined), null);
});

// ─────────────────────────────────────────── ② prompt 回溯（T）

test("prompt 回溯：每條候選讀回的正是產生它用的那份 prompt", () => {
  const set = addShotCandidate(addN(2), {
    id: "c3",
    prompt: "  雨夜码头，特写，眼神  ",
    model: "seedance-2.5-900-特惠",
  }).set;
  assert.equal(shotCandidatePrompt(set, "c1"), "prompt-1");
  assert.equal(shotCandidatePrompt(set, "c3"), "雨夜码头，特写，眼神", "讀回值先 trim");
  assert.equal(shotCandidatePrompt(set, "nope"), null);
  assert.equal(shotCandidatePrompt(undefined, "c1"), null);
  assert.equal(selectedShotCandidatePrompt(selectShotCandidate(set, "c3").set), "雨夜码头，特写，眼神");
});

test("prompt 回溯：節點讀回（metadata → 候選集）", () => {
  const set = addShotCandidate(undefined, { id: "c1", prompt: "第一版 prompt" }).set;
  const node = shotNode("n1", "001", shotCandidatesMetadata(set));
  const readBack = readShotCandidates(node.metadata);
  assert.equal(readBack?.items[0]?.prompt, "第一版 prompt");
  assert.equal(readBack?.selectedId, "c1");
  assert.equal(readShotCandidates({}), null, "缺鍵＝null（不製造半形候選集）");
  assert.equal(readShotCandidates({ shotCandidates: { items: [] } }), null, "空集合＝null");
});

test("清洗：超量截到 4、同 id 去重、非成員 selectedId 丟棄、未知欄位不放行", () => {
  const dirty = {
    items: [
      { id: "a", prompt: "p-a", hacker: "x" },
      { id: "a", prompt: "重複 id 丟棄" },
      { id: "b", prompt: "p-b" },
      { id: "c", prompt: "p-c" },
      { id: "d", prompt: "p-d" },
      { id: "e", prompt: "p-e（超量）" },
      { id: "f", prompt: "" },
      "不是物件",
    ],
    selectedId: "e",
  };
  const cleaned = normalizeShotCandidates(dirty);
  assert.ok(cleaned);
  assert.equal(cleaned.items.length, SHOT_CANDIDATE_LIMIT);
  assert.deepEqual(cleaned.items.map((i) => i.id), ["a", "b", "c", "d"]);
  assert.equal(cleaned.selectedId, undefined, "星標指向被截掉的條目＝不製造懸空星標");
  assert.deepEqual(Object.keys(cleaned.items[0]).sort(), ["id", "prompt"], "未知欄位不放行");
  assert.equal(normalizeShotCandidates({ items: "not-array" }), undefined);
  assert.equal(
    normalizeShotCandidates({ items: [{ id: "x", prompt: "字".repeat(MAX_SHOT_CANDIDATE_PROMPT_CHARS + 10) }] })
      ?.items[0]?.prompt.length,
    MAX_SHOT_CANDIDATE_PROMPT_CHARS,
    "prompt 超長截斷（與分鏡快照同把尺）",
  );
});

test("雙白名單：shotCandidates 與 episodeId 經 compactMetadataForAgent → toNodeMetadata 真往復存活", () => {
  const set = addShotCandidate(addN(2), { id: "c3", prompt: "第三版", model: "seedance-2.5-900-特惠" }).set;
  const restored = roundTrip({ ...shotCandidatesMetadata(set), episodeId: "ep-7" });
  assert.deepEqual(restored.shotCandidates, set, "候選集＋星標逐欄存活（漏一端＝刷新後憑空消失）");
  assert.equal(restored.shotCandidates?.selectedId, "c1");
  assert.equal(restored.episodeId, "ep-7");

  // 髒星標經真清洗器被剝（負向對照）
  const dirty = roundTrip({
    shotCandidates: { items: [{ id: "only", prompt: "p" }], selectedId: "ghost" },
  });
  assert.equal(dirty.shotCandidates?.selectedId, undefined);
});

// ─────────────────────────────────────────── ③ 拿回 prompt 重跑

test("重跑請求：星標候選 prompt 優先，其次節點 prompt；都沒有＝null（不編造）", () => {
  const set = addShotCandidate(addN(2), { id: "c3", prompt: "星標這條", model: "model-x" }).set;
  const starred = shotRerunRequest(
    shotNode("n1", "001", { ...shotCandidatesMetadata(selectShotCandidate(set, "c3").set), prompt: "節點舊 prompt", model: "old-model" }),
  );
  assert.deepEqual(starred, { nodeId: "n1", shotNumber: "001", prompt: "星標這條", model: "model-x" });

  const fallback = shotRerunRequest(shotNode("n2", "002", { prompt: "沒抽卡時的一次生成 prompt" }));
  assert.deepEqual(fallback, { nodeId: "n2", shotNumber: "002", prompt: "沒抽卡時的一次生成 prompt" });

  assert.equal(shotRerunRequest(shotNode("n3", "003", {})), null, "沒有 prompt 就沒有重跑");
  assert.equal(shotRerunRequest({ id: "x", type: CanvasNodeType.Text, title: "t", position: { x: 0, y: 0 }, width: 1, height: 1 }), null);
});

// ─────────────────────────────────────────── ⑤ 旁白文本＋雙音軌（audioAnchorId 的生產者）

test("音軌綁定：對白軌優先當錨（audioAnchorId = dialogueAudioId || narrationAudioId）", () => {
  const dialogue = bindShotAudioTrack(undefined, "dialogue", "https://cdn.example.com/line.mp3");
  assert.equal(dialogue.accepted, true);
  assert.equal(dialogue.patch.dialogueAudioId, "https://cdn.example.com/line.mp3");
  assert.equal(dialogue.patch.audioAnchorId, "https://cdn.example.com/line.mp3", "單軌時錨＝該軌");

  const both = bindShotAudioTrack(dialogue.patch as CanvasNodeMetadata, "narration", "https://cdn.example.com/vo.m4a");
  assert.equal(both.patch.narrationAudioId, "https://cdn.example.com/vo.m4a");
  assert.equal(both.patch.dialogueAudioId, "https://cdn.example.com/line.mp3", "綁旁白不動對白軌");
  assert.equal(both.patch.audioAnchorId, "https://cdn.example.com/line.mp3", "有對白軌時錨＝對白軌（優先）");
  // 純函式：不改輸入
  assert.equal(dialogue.patch.narrationAudioId, undefined);
});

test("音軌綁定：只有旁白軌時錨＝旁白軌；清除後錨不再指向被清的那軌", () => {
  const narrationOnly = bindShotAudioTrack(undefined, "narration", "data:audio/mpeg;base64,AAAA");
  assert.equal(narrationOnly.accepted, true);
  assert.equal(narrationOnly.patch.narrationAudioId, "data:audio/mpeg;base64,AAAA", "data:audio/* 收（同一把尺）");
  assert.equal(narrationOnly.patch.audioAnchorId, "data:audio/mpeg;base64,AAAA", "無對白軌時錨＝旁白軌");

  const withDialogue = bindShotAudioTrack(narrationOnly.patch as CanvasNodeMetadata, "dialogue", "https://cdn.example.com/line.wav");
  assert.equal(withDialogue.patch.audioAnchorId, "https://cdn.example.com/line.wav");

  const cleared = clearShotAudioTrack(withDialogue.patch as CanvasNodeMetadata, "dialogue");
  assert.equal(cleared.accepted, true);
  assert.equal(cleared.patch.dialogueAudioId, undefined, "對白軌被清");
  assert.equal(cleared.patch.audioAnchorId, "data:audio/mpeg;base64,AAAA", "錨回退到剩餘的旁白軌（不指向被清的那軌）");

  const allCleared = clearShotAudioTrack(cleared.patch as CanvasNodeMetadata, "narration");
  assert.equal(allCleared.patch.audioAnchorId, undefined, "兩軌皆清＝不寫懸空錨");
  assert.deepEqual(allCleared.patch, {});
});

test("音軌綁定：非音頻值（.png 圖 URL／無副檔名裸 URL）明確拒絕，不冒充已綁定", () => {
  const png = bindShotAudioTrack(undefined, "dialogue", "https://cdn.example.com/a.png");
  assert.equal(png.accepted, false);
  assert.equal(png.reason, "invalid-audio");
  assert.deepEqual(png.patch, {}, "拒絕＝不寫任何音軌鍵");

  const bare = bindShotAudioTrack(undefined, "narration", "https://cdn.example.com/no-extension");
  assert.equal(bare.accepted, false);
  assert.equal(bare.patch.narrationAudioId, undefined);
  assert.equal(bare.patch.audioAnchorId, undefined);
});

test("音軌四鍵經雙白名單真往復存活（漏一端＝刷新後音軌與錨消失）", () => {
  const bound = bindShotAudioTrack(undefined, "dialogue", "https://cdn.example.com/line.mp3");
  const restored = roundTrip({ ...bound.patch, narration: "她推开门。" } as CanvasNodeMetadata) as Record<string, unknown>;
  assert.equal(restored.dialogueAudioId, "https://cdn.example.com/line.mp3");
  assert.equal(restored.narrationAudioId, undefined);
  assert.equal(restored.audioAnchorId, "https://cdn.example.com/line.mp3");
  assert.equal(restored.narration, "她推开门。");
});

// ─────────────────────────────────────────── ④ 增刪複製重排

const LIST = [
  { nodeId: "n1", shotNumber: "001" },
  { nodeId: "n2", shotNumber: "002" },
  { nodeId: "n3", shotNumber: "003" },
];

test("增：插入到指定位置（含末尾追加）；撞號／撞節點 id／越界都被拒絕", () => {
  const mid = insertShotEntry(LIST, 1, { nodeId: "n9", shotNumber: "001B" });
  assert.equal(mid.ok, true);
  assert.deepEqual(mid.shots.map((s) => s.nodeId), ["n1", "n9", "n2", "n3"]);

  const tail = insertShotEntry(LIST, LIST.length, { nodeId: "n9", shotNumber: "004" });
  assert.deepEqual(tail.shots.map((s) => s.shotNumber), ["001", "002", "003", "004"]);

  assert.equal(insertShotEntry(LIST, 1, { nodeId: "n9", shotNumber: "002" }).reason, "duplicate-shot-number");
  assert.equal(insertShotEntry(LIST, 1, { nodeId: "n2", shotNumber: "004" }).reason, "duplicate-node");
  assert.equal(insertShotEntry(LIST, 9, { nodeId: "n9", shotNumber: "004" }).reason, "out-of-range");
  assert.deepEqual(LIST.map((s) => s.nodeId), ["n1", "n2", "n3"], "輸入清單不被就地改寫");
});

test("刪：刪一顆；未知節點拒絕", () => {
  const removed = deleteShotEntry(LIST, "n2");
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.shots.map((s) => s.shotNumber), ["001", "003"]);
  assert.equal(deleteShotEntry(LIST, "ghost").reason, "unknown-node");
  assert.deepEqual(deleteShotEntry(LIST, "ghost").shots, LIST);
});

test("複製：新項插在來源正後一格；新鏡號必須未用過", () => {
  const copy = duplicateShotEntry(LIST, "n2", { nodeId: "n2-copy", shotNumber: "002B" });
  assert.equal(copy.ok, true);
  assert.deepEqual(copy.shots.map((s) => s.nodeId), ["n1", "n2", "n2-copy", "n3"]);
  assert.equal(duplicateShotEntry(LIST, "n2", { nodeId: "n2-copy", shotNumber: "003" }).reason, "duplicate-shot-number");
  assert.equal(duplicateShotEntry(LIST, "ghost", { nodeId: "x", shotNumber: "009" }).reason, "unknown-node");
});

test("重排：移到目標索引（最終位置）；原位移動是 no-op；越界拒絕", () => {
  const up = moveShotEntry(LIST, "n3", 0);
  assert.deepEqual(up.shots.map((s) => s.shotNumber), ["003", "001", "002"]);

  const down = moveShotEntry(LIST, "n1", 2);
  assert.deepEqual(down.shots.map((s) => s.shotNumber), ["002", "003", "001"]);

  const same = moveShotEntry(LIST, "n2", 1);
  assert.equal(same.ok, true);
  assert.deepEqual(same.shots.map((s) => s.shotNumber), ["001", "002", "003"]);

  assert.equal(moveShotEntry(LIST, "n1", 3).reason, "out-of-range");
  assert.equal(moveShotEntry(LIST, "ghost", 0).reason, "unknown-node");
});

test("清單抽取：非分鏡節點自動剔除（不臆造鏡號）", () => {
  const entries = shotListEntries([
    shotNode("n1", "001"),
    shotNode("n2", "002"),
    { id: "t1", type: CanvasNodeType.Text, title: "文本", position: { x: 0, y: 0 }, width: 1, height: 1 },
  ]);
  assert.deepEqual(entries, [
    { nodeId: "n1", shotNumber: "001" },
    { nodeId: "n2", shotNumber: "002" },
  ]);
  assert.equal(shotNumberOf(undefined), undefined);
});

test("複製節點：換身份、剝掉來源那格的產物與裁決、卡引用照抄、原節點不動", () => {
  const set = addShotCandidate(undefined, { id: "c1", prompt: "來源格的 prompt" }).set;
  const source = shotNode("n1", "001", {
    ...shotCandidatesMetadata(set),
    prompt: "舊 prompt",
    model: "model-a",
    entityCardId: "card-auto-1",
    approval: { status: "approved" },
    directorStageId: "stage-1",
    shotId: "001",
    characterCardIds: ["char-a"],
    sceneCardIds: ["scene-a"],
  });
  const frozen = JSON.parse(JSON.stringify(source)) as CanvasNode;

  const copy = cloneShotNode(source, { id: "n1-copy", shotNumber: "001B" });
  assert.equal(copy.id, "n1-copy");
  assert.equal(copy.metadata?.storyboardShot?.shotNumber, "001B");
  assert.equal(copy.title, "镜头 001 001B", "標題帶新鏡號（複製品不與來源同名）");
  assert.equal(copy.metadata?.shotCandidates, undefined, "新格沒抽卡");
  assert.equal(copy.metadata?.entityCardId, undefined, "落卡冪等標記屬於來源節點");
  assert.equal(copy.metadata?.approval, undefined, "複製品是未批准的新稿");
  assert.equal(copy.metadata?.directorStageId, undefined);
  assert.equal(copy.metadata?.shotId, undefined);
  assert.deepEqual(copy.metadata?.characterCardIds, ["char-a"], "卡引用照抄（這一鏡的內容）");
  assert.deepEqual(copy.metadata?.sceneCardIds, ["scene-a"]);
  assert.deepEqual(source, frozen, "來源節點零改動");
  assert.notEqual(copy.metadata, source.metadata, "metadata 是深拷貝（不共用參考）");
});

// ─────────────────────────────────────────── ⑥ 單鏡媒體就緒（引導面板進度推導）

test("媒體就緒：三支音軌鍵任一非空＝hasAudio；旁白文本不算配音", () => {
  const dialogue = shotMediaReadiness({ dialogueAudioId: "https://cdn.example.com/line.mp3" });
  assert.equal(dialogue.hasAudio, true);
  assert.equal(dialogue.hasImage, false);
  assert.equal(dialogue.hasVideo, false);

  assert.equal(shotMediaReadiness({ narrationAudioId: "vo-asset-1" }).hasAudio, true, "資產 id 非 URL 也認（判準＝非空，非副檔名）");
  assert.equal(shotMediaReadiness({ audioAnchorId: "anchor-1" }).hasAudio, true, "錨鍵單獨存在也算配音就緒");
});

test("媒體就緒：narration（旁白文本）是輸入不是配音交付物 → hasAudio 仍 false", () => {
  const text = shotMediaReadiness({ narration: "她推开门，雨还在下。" });
  assert.equal(text.hasAudio, false, "文本不冒充配音（旁白要真的逐鏡合成出音軌）");
  assert.equal(text.hasImage, false);
  assert.equal(text.hasVideo, false);
});

test("媒體就緒：缺鍵／空字串／純空白一律不算有值 → 三個 false", () => {
  assert.deepEqual(shotMediaReadiness({}), { hasImage: false, hasVideo: false, hasAudio: false });
  const blank = shotMediaReadiness({
    dialogueAudioId: "   ",
    narrationAudioId: "",
    audioAnchorId: "\t",
    shotCandidates: { items: [] },
  });
  assert.deepEqual(blank, { hasImage: false, hasVideo: false, hasAudio: false });
});

test("媒體就緒：shotCandidates 有星標採用稿＝hasImage；有候選未星標不算", () => {
  const starred = addShotCandidate(undefined, { id: "c1", prompt: "p1" }).set; // 首條自動上星標
  const adopted = shotMediaReadiness({ shotCandidates: starred });
  assert.equal(adopted.hasImage, true, "有採用稿（星標）＝圖就緒");
  assert.equal(adopted.hasVideo, false, "候選沒有影片語義，不冒充影片");

  const unstarred = normalizeShotCandidates({ items: [{ id: "c1", prompt: "p1" }] });
  assert.equal(shotMediaReadiness({ shotCandidates: unstarred }).hasImage, false, "有候選但無採用稿＝不算（照既有星標語義）");
});

test("媒體就緒：影片只認影片語義欄位（taskVersions 的 main_video ＋真 URL）；有圖≠有影", () => {
  const video = shotMediaReadiness({
    taskVersions: { items: [{ version: "2026-09-30T10:00:00.000Z", tags: ["main_video"], url: "https://cdn.example.com/clip.mp4" }] },
  });
  assert.equal(video.hasVideo, true);
  assert.equal(video.hasImage, false);

  const image = shotMediaReadiness({
    taskVersions: { items: [{ version: "2026-09-30T10:00:00.000Z", tags: ["main_image"], url: "https://cdn.example.com/frame.png" }] },
  });
  assert.equal(image.hasImage, true);
  assert.equal(image.hasVideo, false, "有圖≠有影（不用圖冒充影片）");

  const planned = shotMediaReadiness({
    taskVersions: { items: [{ version: "2026-09-30T10:00:00.000Z", tags: ["main_video"] }] },
  });
  assert.equal(planned.hasVideo, false, "有版本但無交付 URL＝只有計畫值，不算就緒");
});