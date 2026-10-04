// 分镜级抽卡＋星标＋prompt 回溯＋增删复制重排（P1-2）行为测试。
//
// 全部是**真函式行为断言**：真加候选、真星标、真回溯、真移动清单、真往复双白名单；
// 不含源码字串扫描（那种只算变更探针）。
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

/** 真往复：真上行压缩 → 真还原端清洗。 */
function roundTrip(metadata: CanvasNodeMetadata): CanvasNodeMetadata {
  return toNodeMetadata(compactMetadataForAgent(metadata));
}

function addN(count: number): StoryboardShotCandidateSet {
  let set: StoryboardShotCandidateSet | undefined;
  for (let i = 0; i < count; i += 1) {
    const result = addShotCandidate(set, { id: `c${i + 1}`, prompt: `prompt-${i + 1}` });
    assert.equal(result.accepted, true, `第 ${i + 1} 条候选应被接受`);
    set = result.set;
  }
  assert.ok(set);
  return set;
}

// ─────────────────────────────────────────── ① 抽卡：候选集＋星标

test("抽卡：一分镜最多 4 条，第 5 条被明确拒绝（不是静默丢弃）", () => {
  const set = addN(SHOT_CANDIDATE_LIMIT);
  assert.equal(set.items.length, SHOT_CANDIDATE_LIMIT);
  assert.equal(SHOT_CANDIDATE_LIMIT, 4, "D9 逐字：一分镜 ≤4 条");

  const overflow = addShotCandidate(set, { id: "c5", prompt: "第五条" });
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.reason, "full");
  assert.equal(overflow.set.items.length, 4, "塞不下时集合原样不动");
});

test("抽卡：缺 prompt／缺 id 的候选整条拒绝（没有溯源的候选不成立）", () => {
  const noPrompt = addShotCandidate(undefined, { id: "c1", prompt: "   " });
  assert.equal(noPrompt.accepted, false);
  assert.equal(noPrompt.reason, "invalid");
  assert.deepEqual(noPrompt.set.items, []);

  const noId = addShotCandidate(undefined, { prompt: "有 prompt 没 id" });
  assert.equal(noId.accepted, false);
  assert.equal(noId.reason, "invalid");

  const dup = addShotCandidate(addN(1), { id: "c1", prompt: "重复 id" });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, "duplicate");
});

test("星标：首条自动选定；只有成员能被选中；删掉星标者回退剩余第一条", () => {
  const set = addN(3);
  assert.equal(set.selectedId, "c1", "首条自动上星标（一镜要有采用稿）");

  const toC3 = selectShotCandidate(set, "c3");
  assert.equal(toC3.selected, true);
  assert.equal(toC3.set.selectedId, "c3");
  assert.equal(set.selectedId, "c1", "选星标不动原集合（纯函式）");

  const ghost = selectShotCandidate(set, "not-a-member");
  assert.equal(ghost.selected, false);
  assert.equal(ghost.set.selectedId, "c1", "非成员不可选中（不制造悬空星标）");

  const removed = removeShotCandidate(toC3.set, "c3");
  assert.equal(removed.removed, true);
  assert.equal(removed.set.selectedId, "c1", "删掉星标者回退剩余第一条");

  const removedOther = removeShotCandidate(toC3.set, "c1");
  assert.equal(removedOther.set.selectedId, "c3", "删非星标者不动星标");

  let empty = toC3.set;
  for (const item of [...toC3.set.items]) empty = removeShotCandidate(empty, item.id).set;
  assert.deepEqual(empty.items, []);
  assert.equal(empty.selectedId, undefined);
  assert.deepEqual(shotCandidatesMetadata(empty), {}, "候选清空＝省略整个键（不写空壳）");
});

test("星标读回：selectedShotCandidate 指向星标那一条（真值比对）", () => {
  const set = selectShotCandidate(addN(3), "c2").set;
  const selected = selectedShotCandidate(set);
  assert.equal(selected?.id, "c2");
  assert.equal(selected?.prompt, "prompt-2");
  assert.equal(selectedShotCandidate({ items: [] }), null);
  assert.equal(selectedShotCandidate(undefined), null);
});

// ─────────────────────────────────────────── ② prompt 回溯（T）

test("prompt 回溯：每条候选读回的正是产生它用的那份 prompt", () => {
  const set = addShotCandidate(addN(2), {
    id: "c3",
    prompt: "  雨夜码头，特写，眼神  ",
    model: "seedance-2.5-900-特惠",
  }).set;
  assert.equal(shotCandidatePrompt(set, "c1"), "prompt-1");
  assert.equal(shotCandidatePrompt(set, "c3"), "雨夜码头，特写，眼神", "读回值先 trim");
  assert.equal(shotCandidatePrompt(set, "nope"), null);
  assert.equal(shotCandidatePrompt(undefined, "c1"), null);
  assert.equal(selectedShotCandidatePrompt(selectShotCandidate(set, "c3").set), "雨夜码头，特写，眼神");
});

test("prompt 回溯：节点读回（metadata → 候选集）", () => {
  const set = addShotCandidate(undefined, { id: "c1", prompt: "第一版 prompt" }).set;
  const node = shotNode("n1", "001", shotCandidatesMetadata(set));
  const readBack = readShotCandidates(node.metadata);
  assert.equal(readBack?.items[0]?.prompt, "第一版 prompt");
  assert.equal(readBack?.selectedId, "c1");
  assert.equal(readShotCandidates({}), null, "缺键＝null（不制造半形候选集）");
  assert.equal(readShotCandidates({ shotCandidates: { items: [] } }), null, "空集合＝null");
});

test("清洗：超量截到 4、同 id 去重、非成员 selectedId 丢弃、未知栏位不放行", () => {
  const dirty = {
    items: [
      { id: "a", prompt: "p-a", hacker: "x" },
      { id: "a", prompt: "重复 id 丢弃" },
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
  assert.equal(cleaned.selectedId, undefined, "星标指向被截掉的条目＝不制造悬空星标");
  assert.deepEqual(Object.keys(cleaned.items[0]).sort(), ["id", "prompt"], "未知栏位不放行");
  assert.equal(normalizeShotCandidates({ items: "not-array" }), undefined);
  assert.equal(
    normalizeShotCandidates({ items: [{ id: "x", prompt: "字".repeat(MAX_SHOT_CANDIDATE_PROMPT_CHARS + 10) }] })
      ?.items[0]?.prompt.length,
    MAX_SHOT_CANDIDATE_PROMPT_CHARS,
    "prompt 超长截断（与分镜快照同把尺）",
  );
});

test("双白名单：shotCandidates 与 episodeId 经 compactMetadataForAgent → toNodeMetadata 真往复存活", () => {
  const set = addShotCandidate(addN(2), { id: "c3", prompt: "第三版", model: "seedance-2.5-900-特惠" }).set;
  const restored = roundTrip({ ...shotCandidatesMetadata(set), episodeId: "ep-7" });
  assert.deepEqual(restored.shotCandidates, set, "候选集＋星标逐栏存活（漏一端＝刷新后凭空消失）");
  assert.equal(restored.shotCandidates?.selectedId, "c1");
  assert.equal(restored.episodeId, "ep-7");

  // 脏星标经真清洗器被剥（负向对照）
  const dirty = roundTrip({
    shotCandidates: { items: [{ id: "only", prompt: "p" }], selectedId: "ghost" },
  });
  assert.equal(dirty.shotCandidates?.selectedId, undefined);
});

// ─────────────────────────────────────────── ③ 拿回 prompt 重跑

test("重跑请求：星标候选 prompt 优先，其次节点 prompt；都没有＝null（不编造）", () => {
  const set = addShotCandidate(addN(2), { id: "c3", prompt: "星标这条", model: "model-x" }).set;
  const starred = shotRerunRequest(
    shotNode("n1", "001", { ...shotCandidatesMetadata(selectShotCandidate(set, "c3").set), prompt: "节点旧 prompt", model: "old-model" }),
  );
  assert.deepEqual(starred, { nodeId: "n1", shotNumber: "001", prompt: "星标这条", model: "model-x" });

  const fallback = shotRerunRequest(shotNode("n2", "002", { prompt: "没抽卡时的一次生成 prompt" }));
  assert.deepEqual(fallback, { nodeId: "n2", shotNumber: "002", prompt: "没抽卡时的一次生成 prompt" });

  assert.equal(shotRerunRequest(shotNode("n3", "003", {})), null, "没有 prompt 就没有重跑");
  assert.equal(shotRerunRequest({ id: "x", type: CanvasNodeType.Text, title: "t", position: { x: 0, y: 0 }, width: 1, height: 1 }), null);
});

// ─────────────────────────────────────────── ⑤ 旁白文本＋双音轨（audioAnchorId 的生产者）

test("音轨绑定：对白轨优先当锚（audioAnchorId = dialogueAudioId || narrationAudioId）", () => {
  const dialogue = bindShotAudioTrack(undefined, "dialogue", "https://cdn.example.com/line.mp3");
  assert.equal(dialogue.accepted, true);
  assert.equal(dialogue.patch.dialogueAudioId, "https://cdn.example.com/line.mp3");
  assert.equal(dialogue.patch.audioAnchorId, "https://cdn.example.com/line.mp3", "单轨时锚＝该轨");

  const both = bindShotAudioTrack(dialogue.patch as CanvasNodeMetadata, "narration", "https://cdn.example.com/vo.m4a");
  assert.equal(both.patch.narrationAudioId, "https://cdn.example.com/vo.m4a");
  assert.equal(both.patch.dialogueAudioId, "https://cdn.example.com/line.mp3", "绑旁白不动对白轨");
  assert.equal(both.patch.audioAnchorId, "https://cdn.example.com/line.mp3", "有对白轨时锚＝对白轨（优先）");
  // 纯函式：不改输入
  assert.equal(dialogue.patch.narrationAudioId, undefined);
});

test("音轨绑定：只有旁白轨时锚＝旁白轨；清除后锚不再指向被清的那轨", () => {
  const narrationOnly = bindShotAudioTrack(undefined, "narration", "data:audio/mpeg;base64,AAAA");
  assert.equal(narrationOnly.accepted, true);
  assert.equal(narrationOnly.patch.narrationAudioId, "data:audio/mpeg;base64,AAAA", "data:audio/* 收（同一把尺）");
  assert.equal(narrationOnly.patch.audioAnchorId, "data:audio/mpeg;base64,AAAA", "无对白轨时锚＝旁白轨");

  const withDialogue = bindShotAudioTrack(narrationOnly.patch as CanvasNodeMetadata, "dialogue", "https://cdn.example.com/line.wav");
  assert.equal(withDialogue.patch.audioAnchorId, "https://cdn.example.com/line.wav");

  const cleared = clearShotAudioTrack(withDialogue.patch as CanvasNodeMetadata, "dialogue");
  assert.equal(cleared.accepted, true);
  assert.equal(cleared.patch.dialogueAudioId, undefined, "对白轨被清");
  assert.equal(cleared.patch.audioAnchorId, "data:audio/mpeg;base64,AAAA", "锚回退到剩余的旁白轨（不指向被清的那轨）");

  const allCleared = clearShotAudioTrack(cleared.patch as CanvasNodeMetadata, "narration");
  assert.equal(allCleared.patch.audioAnchorId, undefined, "两轨皆清＝不写悬空锚");
  assert.deepEqual(allCleared.patch, {});
});

test("音轨绑定：非音频值（.png 图 URL／无副档名裸 URL）明确拒绝，不冒充已绑定", () => {
  const png = bindShotAudioTrack(undefined, "dialogue", "https://cdn.example.com/a.png");
  assert.equal(png.accepted, false);
  assert.equal(png.reason, "invalid-audio");
  assert.deepEqual(png.patch, {}, "拒绝＝不写任何音轨键");

  const bare = bindShotAudioTrack(undefined, "narration", "https://cdn.example.com/no-extension");
  assert.equal(bare.accepted, false);
  assert.equal(bare.patch.narrationAudioId, undefined);
  assert.equal(bare.patch.audioAnchorId, undefined);
});

test("音轨四键经双白名单真往复存活（漏一端＝刷新后音轨与锚消失）", () => {
  const bound = bindShotAudioTrack(undefined, "dialogue", "https://cdn.example.com/line.mp3");
  const restored = roundTrip({ ...bound.patch, narration: "她推开门。" } as CanvasNodeMetadata) as Record<string, unknown>;
  assert.equal(restored.dialogueAudioId, "https://cdn.example.com/line.mp3");
  assert.equal(restored.narrationAudioId, undefined);
  assert.equal(restored.audioAnchorId, "https://cdn.example.com/line.mp3");
  assert.equal(restored.narration, "她推开门。");
});

// ─────────────────────────────────────────── ④ 增删复制重排

const LIST = [
  { nodeId: "n1", shotNumber: "001" },
  { nodeId: "n2", shotNumber: "002" },
  { nodeId: "n3", shotNumber: "003" },
];

test("增：插入到指定位置（含末尾追加）；撞号／撞节点 id／越界都被拒绝", () => {
  const mid = insertShotEntry(LIST, 1, { nodeId: "n9", shotNumber: "001B" });
  assert.equal(mid.ok, true);
  assert.deepEqual(mid.shots.map((s) => s.nodeId), ["n1", "n9", "n2", "n3"]);

  const tail = insertShotEntry(LIST, LIST.length, { nodeId: "n9", shotNumber: "004" });
  assert.deepEqual(tail.shots.map((s) => s.shotNumber), ["001", "002", "003", "004"]);

  assert.equal(insertShotEntry(LIST, 1, { nodeId: "n9", shotNumber: "002" }).reason, "duplicate-shot-number");
  assert.equal(insertShotEntry(LIST, 1, { nodeId: "n2", shotNumber: "004" }).reason, "duplicate-node");
  assert.equal(insertShotEntry(LIST, 9, { nodeId: "n9", shotNumber: "004" }).reason, "out-of-range");
  assert.deepEqual(LIST.map((s) => s.nodeId), ["n1", "n2", "n3"], "输入清单不被就地改写");
});

test("删：删一颗；未知节点拒绝", () => {
  const removed = deleteShotEntry(LIST, "n2");
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.shots.map((s) => s.shotNumber), ["001", "003"]);
  assert.equal(deleteShotEntry(LIST, "ghost").reason, "unknown-node");
  assert.deepEqual(deleteShotEntry(LIST, "ghost").shots, LIST);
});

test("复制：新项插在来源正后一格；新镜号必须未用过", () => {
  const copy = duplicateShotEntry(LIST, "n2", { nodeId: "n2-copy", shotNumber: "002B" });
  assert.equal(copy.ok, true);
  assert.deepEqual(copy.shots.map((s) => s.nodeId), ["n1", "n2", "n2-copy", "n3"]);
  assert.equal(duplicateShotEntry(LIST, "n2", { nodeId: "n2-copy", shotNumber: "003" }).reason, "duplicate-shot-number");
  assert.equal(duplicateShotEntry(LIST, "ghost", { nodeId: "x", shotNumber: "009" }).reason, "unknown-node");
});

test("重排：移到目标索引（最终位置）；原位移动是 no-op；越界拒绝", () => {
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

test("清单抽取：非分镜节点自动剔除（不臆造镜号）", () => {
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

test("复制节点：换身份、剥掉来源那格的产物与裁决、卡引用照抄、原节点不动", () => {
  const set = addShotCandidate(undefined, { id: "c1", prompt: "来源格的 prompt" }).set;
  const source = shotNode("n1", "001", {
    ...shotCandidatesMetadata(set),
    prompt: "旧 prompt",
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
  assert.equal(copy.title, "镜头 001 001B", "标题带新镜号（复制品不与来源同名）");
  assert.equal(copy.metadata?.shotCandidates, undefined, "新格没抽卡");
  assert.equal(copy.metadata?.entityCardId, undefined, "落卡幂等标记属于来源节点");
  assert.equal(copy.metadata?.approval, undefined, "复制品是未批准的新稿");
  assert.equal(copy.metadata?.directorStageId, undefined);
  assert.equal(copy.metadata?.shotId, undefined);
  assert.deepEqual(copy.metadata?.characterCardIds, ["char-a"], "卡引用照抄（这一镜的内容）");
  assert.deepEqual(copy.metadata?.sceneCardIds, ["scene-a"]);
  assert.deepEqual(source, frozen, "来源节点零改动");
  assert.notEqual(copy.metadata, source.metadata, "metadata 是深拷贝（不共用参考）");
});

// ─────────────────────────────────────────── ⑥ 单镜媒体就绪（引导面板进度推导）

test("媒体就绪：三支音轨键任一非空＝hasAudio；旁白文本不算配音", () => {
  const dialogue = shotMediaReadiness({ dialogueAudioId: "https://cdn.example.com/line.mp3" });
  assert.equal(dialogue.hasAudio, true);
  assert.equal(dialogue.hasImage, false);
  assert.equal(dialogue.hasVideo, false);

  assert.equal(shotMediaReadiness({ narrationAudioId: "vo-asset-1" }).hasAudio, true, "资产 id 非 URL 也认（判准＝非空，非副档名）");
  assert.equal(shotMediaReadiness({ audioAnchorId: "anchor-1" }).hasAudio, true, "锚键单独存在也算配音就绪");
});

test("媒体就绪：narration（旁白文本）是输入不是配音交付物 → hasAudio 仍 false", () => {
  const text = shotMediaReadiness({ narration: "她推开门，雨还在下。" });
  assert.equal(text.hasAudio, false, "文本不冒充配音（旁白要真的逐镜合成出音轨）");
  assert.equal(text.hasImage, false);
  assert.equal(text.hasVideo, false);
});

test("媒体就绪：缺键／空字串／纯空白一律不算有值 → 三个 false", () => {
  assert.deepEqual(shotMediaReadiness({}), { hasImage: false, hasVideo: false, hasAudio: false });
  const blank = shotMediaReadiness({
    dialogueAudioId: "   ",
    narrationAudioId: "",
    audioAnchorId: "\t",
    shotCandidates: { items: [] },
  });
  assert.deepEqual(blank, { hasImage: false, hasVideo: false, hasAudio: false });
});

test("媒体就绪：shotCandidates 有星标采用稿＝hasImage；有候选未星标不算", () => {
  const starred = addShotCandidate(undefined, { id: "c1", prompt: "p1" }).set; // 首条自动上星标
  const adopted = shotMediaReadiness({ shotCandidates: starred });
  assert.equal(adopted.hasImage, true, "有采用稿（星标）＝图就绪");
  assert.equal(adopted.hasVideo, false, "候选没有影片语义，不冒充影片");

  const unstarred = normalizeShotCandidates({ items: [{ id: "c1", prompt: "p1" }] });
  assert.equal(shotMediaReadiness({ shotCandidates: unstarred }).hasImage, false, "有候选但无采用稿＝不算（照既有星标语义）");
});

test("媒体就绪：影片只认影片语义栏位（taskVersions 的 main_video ＋真 URL）；有图≠有影", () => {
  const video = shotMediaReadiness({
    taskVersions: { items: [{ version: "2026-09-30T10:00:00.000Z", tags: ["main_video"], url: "https://cdn.example.com/clip.mp4" }] },
  });
  assert.equal(video.hasVideo, true);
  assert.equal(video.hasImage, false);

  const image = shotMediaReadiness({
    taskVersions: { items: [{ version: "2026-09-30T10:00:00.000Z", tags: ["main_image"], url: "https://cdn.example.com/frame.png" }] },
  });
  assert.equal(image.hasImage, true);
  assert.equal(image.hasVideo, false, "有图≠有影（不用图冒充影片）");

  const planned = shotMediaReadiness({
    taskVersions: { items: [{ version: "2026-09-30T10:00:00.000Z", tags: ["main_video"] }] },
  });
  assert.equal(planned.hasVideo, false, "有版本但无交付 URL＝只有计画值，不算就绪");
});