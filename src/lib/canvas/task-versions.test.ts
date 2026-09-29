// 任務版本（Version）＋標籤（Tags）＋選中（Selected）行為測試（P1-9，對稱差 D37）。
//
// 全部是**真函式行為斷言**：真追加、真回填、真星標、真刪除回退、真標籤分組、
// 真 `toNodeMetadata(compactMetadataForAgent(...))` 往復；不含源碼字串掃描
// （那種只算變更探針，不計入已驗證）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendTaskVersion,
  groupTaskVersionsByTag,
  latestTaskVersion,
  MAX_TASK_VERSIONS_PER_NODE,
  normalizeTaskTags,
  normalizeTaskVersion,
  normalizeTaskVersions,
  groupTaskVersionsByTag as _groupAlias,
  readTaskVersions,
  removeTaskVersion,
  selectedTaskVersion,
  selectedTaskVersionUrl,
  selectTaskVersion,
  TASK_TAGS,
  taskTagForKind,
  taskVersionsByTag,
  taskVersionsMetadata,
  taskVersionsWithTag,
  taskVersionOf,
  updateTaskVersion,
} from "./task-versions";
import type { TaskTag, TaskVersionSet } from "./task-versions";
import { toNodeMetadata } from "./layout";
import { compactMetadataForAgent } from "@/hooks/canvas/canvas-chat-types";
import { CanvasNodeType } from "./types";
import type { CanvasNode, CanvasNodeMetadata } from "./types";

void _groupAlias; // 匯出存在但本檔只用得到主要名稱（避免未使用匯入）

/** 固定時戳（秒為單位，逐筆 +5s；避免同毫秒碰撞且讓字典序可讀）。 */
function at(second: number): string {
  return new Date(Date.UTC(2026, 8, 29, 2, 0, second)).toISOString();
}

function node(id: string, metadata: CanvasNodeMetadata = {}): CanvasNode {
  return {
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x: 0, y: 0 },
    width: 320,
    height: 320,
    metadata,
  };
}

// ─────────────────────────────────────────── ① 重跑＝新版本，舊版本存活

test("同一格重跑：追加新版本，舊版本原樣留在清單（不是覆蓋）", () => {
  const first = appendTaskVersion(undefined, {
    version: at(0),
    taskId: "task-1",
    status: "loading",
    tags: ["main_image"],
  });
  assert.equal(first.accepted, true);
  assert.equal(first.set.items.length, 1);
  // 首筆自動上星標（本格要有採用稿；形狀照 addShotCandidate 的首條自動上星）
  assert.equal(first.set.selectedVersion, at(0));

  // 回填同一筆任務的結果：版本不變、不產生新版本
  const filled = updateTaskVersion(first.set, at(0), { status: "success", url: "https://cdn.example.com/v1.png" });
  assert.equal(filled.updated, true);
  assert.equal(filled.set.items.length, 1, "同一任務的回填不得產生新版本");
  assert.equal(filled.set.items[0].version, at(0));
  assert.equal(filled.set.items[0].status, "success");
  assert.equal(filled.set.items[0].url, "https://cdn.example.com/v1.png");

  // 同一格重跑 → 第二筆任務
  const second = appendTaskVersion(filled.set, {
    version: at(5),
    taskId: "task-2",
    status: "success",
    tags: ["main_image"],
    url: "https://cdn.example.com/v2.png",
  });
  assert.equal(second.accepted, true);
  assert.equal(second.set.items.length, 2);
  assert.equal(second.set.items[0].version, at(0), "舊版本必須留著且可辨識");
  assert.equal(second.set.items[0].url, "https://cdn.example.com/v1.png");
  assert.equal(latestTaskVersion(second.set)?.version, at(5));
  assert.equal(second.set.selectedVersion, at(0), "後續追加不得搶星標（星標只走 selectTaskVersion）");

  // 同一任務重放＝duplicate（冪等），集合等值且舊版本零變動
  const replay = appendTaskVersion(second.set, { version: at(5), taskId: "task-2" });
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, "duplicate");
  assert.deepEqual(replay.set.items, second.set.items);
});

test("版本識別：時戳解析不出＝invalid（不編造版本），亂序追加仍按時序排列", () => {
  const bad = appendTaskVersion(undefined, { version: "不是時間", tags: ["main_image"] });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, "invalid");
  assert.deepEqual(bad.set.items, []);

  // 先追加較晚的、再追加較早的 → 清單仍按時序升序（末條＝最新）
  const late = appendTaskVersion(undefined, { version: at(30), tags: ["main_image"] });
  const early = appendTaskVersion(late.set, { version: at(10), tags: ["main_image"] });
  assert.deepEqual(
    early.set.items.map((item) => item.version),
    [at(10), at(30)],
  );
  assert.equal(latestTaskVersion(early.set)?.version, at(30));
  // 正規化：帶時區的輸入也收斂成 UTC ISO（字典序＝時間序）
  assert.equal(normalizeTaskVersion("2026-09-29T10:00:00+08:00"), "2026-09-29T02:00:00.000Z");
});

test("上限：塞不下明說 full（不靜默裁掉舊版本）", () => {
  let set: TaskVersionSet | undefined;
  for (let i = 0; i < MAX_TASK_VERSIONS_PER_NODE; i += 1) {
    const next = appendTaskVersion(set, { version: at(i), tags: ["main_image"] });
    assert.equal(next.accepted, true);
    set = next.set;
  }
  const before = set as TaskVersionSet;
  const overflow = appendTaskVersion(before, { version: at(MAX_TASK_VERSIONS_PER_NODE), tags: ["main_image"] });
  assert.equal(overflow.accepted, false);
  assert.equal(overflow.reason, "full");
  assert.deepEqual(overflow.set.items, before.items, "滿了必須原樣退回（不得靜默裁舊）");
  assert.equal(overflow.set.items[0].version, at(0), "最早的版本仍在");

  // 騰位子的唯一手段＝明確刪除；刪完就能再追加
  const freed = removeTaskVersion(before, at(0));
  assert.equal(freed.removed, true);
  assert.equal(appendTaskVersion(freed.set, { version: at(MAX_TASK_VERSIONS_PER_NODE), tags: ["main_image"] }).accepted, true);
});

// ─────────────────────────────────────────── ② Tags：推導、清洗、查詢、分組

test("標籤推導：照現場既有 kind 詞彙收斂，未知值不猜（不回 main_image）", () => {
  assert.equal(taskTagForKind("image"), "main_image");
  assert.equal(taskTagForKind("image_generate"), "main_image");
  assert.equal(taskTagForKind("image_edit"), "main_image");
  assert.equal(taskTagForKind("video"), "main_video");
  assert.equal(taskTagForKind("video_generate"), "main_video");
  assert.equal(taskTagForKind("main_image"), "main_image", "D37 字面原樣可宣告");
  assert.equal(taskTagForKind("main_video"), "main_video");
  assert.equal(taskTagForKind("tts"), null, "語義上不是主圖/主片：不給標籤");
  assert.equal(taskTagForKind("avatar"), null);
  assert.equal(taskTagForKind("lipsync"), null);
  assert.equal(taskTagForKind("mystery_kind"), null, "未知值不收斂（猜錯會污染分組）");
  assert.equal(taskTagForKind(""), null);
  assert.equal(taskTagForKind(42), null);
  assert.equal(taskTagForKind(undefined), null);
});

test("標籤清洗：未知值丟棄、去重保序；空＝[]（分組是總函式）", () => {
  assert.deepEqual(normalizeTaskTags(["main_video", "main_image", "main_image", "乱七八糟", 7, null]), [
    "main_video",
    "main_image",
  ]);
  assert.deepEqual(normalizeTaskTags(undefined), []);
  assert.deepEqual(normalizeTaskTags("main_image"), [], "非陣列不收（不代為包成單元素）");
});

test("標籤查詢／分組：一格先出圖後出片 → 兩組；跨格查詢只命中帶該標籤的版本", () => {
  const image = appendTaskVersion(undefined, {
    version: at(0),
    taskId: "task-1",
    status: "success",
    tags: [taskTagForKind("image_generate") as TaskTag],
    url: "https://cdn.example.com/1.png",
  });
  const withVideo = appendTaskVersion(image.set, {
    version: at(5),
    taskId: "task-2",
    status: "success",
    tags: [taskTagForKind("video_generate") as TaskTag],
    url: "https://cdn.example.com/1.mp4",
  });

  assert.deepEqual(
    taskVersionsByTag(withVideo.set, "main_image").map((item) => item.version),
    [at(0)],
  );
  assert.deepEqual(
    taskVersionsByTag(withVideo.set, "main_video").map((item) => item.version),
    [at(5)],
  );
  // 分組結果：只出非空的組，順序＝值域序（穩定可比對）
  const groups = groupTaskVersionsByTag(withVideo.set);
  assert.deepEqual(
    groups.map((group) => [group.tag, group.items.length]),
    [
      ["main_image", 1],
      ["main_video", 1],
    ],
  );
  assert.deepEqual(groupTaskVersionsByTag(undefined), []);

  // 跨格查詢
  const nodes = [
    node("n1", { taskVersions: withVideo.set }),
    node("n2", { taskVersions: image.set }),
    node("n3", { content: "文本节点，无任务版本史" }),
  ];
  const hits = taskVersionsWithTag(nodes, "main_video");
  assert.deepEqual(
    hits.map((hit) => [hit.nodeId, hit.entry.version]),
    [["n1", at(5)]],
  );
  assert.deepEqual(taskVersionsWithTag(nodes, "bogus" as TaskTag), [], "值域外標籤零命中（不臆造）");
  assert.deepEqual(
    taskVersionsWithTag(nodes, "main_image").map((hit) => hit.nodeId),
    ["n1", "n2"],
    "沒有該鍵的節點零命中",
  );
});

// ─────────────────────────────────────────── ③ Selected：標記與刪除回退

function twoVersions(): TaskVersionSet {
  const first = appendTaskVersion(undefined, {
    version: at(0),
    taskId: "task-1",
    status: "success",
    tags: ["main_image"],
    url: "https://cdn.example.com/v1.png",
  }).set;
  return appendTaskVersion(first, {
    version: at(5),
    taskId: "task-2",
    status: "success",
    tags: ["main_image"],
    url: "https://cdn.example.com/v2.png",
  }).set;
}

test("Selected：只有成員可被選中（非成員不製造懸空星標）", () => {
  const set = twoVersions();
  const hit = selectTaskVersion(set, at(5));
  assert.equal(hit.selected, true);
  assert.equal(hit.set.selectedVersion, at(5));
  assert.equal(selectedTaskVersion(hit.set)?.taskId, "task-2");
  assert.equal(selectedTaskVersionUrl(hit.set), "https://cdn.example.com/v2.png", "選中者就是採用稿素材");

  const miss = selectTaskVersion(set, at(999));
  assert.equal(miss.selected, false);
  assert.equal(miss.set.selectedVersion, at(0), "未命中不得改星標");
  assert.notEqual(miss.set, set, "拒絕時回等值新物件（呼叫端拿不到可誤改的舊參考）");

  const bad = selectTaskVersion(set, "不是時間");
  assert.equal(bad.selected, false);
  assert.equal(bad.set.selectedVersion, at(0));
});

test("刪除選中者：回退剩餘第一條（同 reducer 批次主圖 kept[0]／removeShotCandidate items[0]）", () => {
  const selected = selectTaskVersion(twoVersions(), at(5)).set;
  const removed = removeTaskVersion(selected, at(5));
  assert.equal(removed.removed, true);
  assert.deepEqual(
    removed.set.items.map((item) => item.version),
    [at(0)],
  );
  assert.equal(removed.set.selectedVersion, at(0), "刪掉星標者 → 回退剩餘第一條");
  assert.equal(selectedTaskVersionUrl(removed.set), "https://cdn.example.com/v1.png");

  // 刪非星標者：星標不動
  const keepSelected = removeTaskVersion(selected, at(0));
  assert.equal(keepSelected.set.selectedVersion, at(5));
  assert.equal(keepSelected.set.items.length, 1);

  // 全刪光：沒有 selectedVersion（集合空 → metadata patch 收成省略鍵）
  const emptied = removeTaskVersion(keepSelected.set, at(5));
  assert.deepEqual(emptied.set.items, []);
  assert.equal(emptied.set.selectedVersion, undefined);
  assert.deepEqual(taskVersionsMetadata(emptied.set), {}, "空集合不寫空殼鍵");

  // 找不到該版：不改（等值新物件）
  const miss = removeTaskVersion(selected, at(123));
  assert.equal(miss.removed, false);
  assert.equal(miss.set.selectedVersion, at(5));
  assert.equal(miss.set.items.length, 2);
});

test("查詢端：taskVersionOf／selectedTaskVersion／latestTaskVersion 對缺席誠實回 null", () => {
  const set = twoVersions();
  assert.equal(taskVersionOf(set, at(0))?.taskId, "task-1");
  assert.equal(taskVersionOf(set, at(999)), null);
  assert.equal(selectedTaskVersion(undefined), null);
  assert.equal(selectedTaskVersionUrl(null), null);
  assert.equal(latestTaskVersion(undefined), null);
});

// ─────────────────────────────────────────── ④ 清洗（讀取端）與雙白名單真往復

test("清洗：逐筆丟非法、同版去重、selectedVersion 非成員即不收、空集合＝省略鍵", () => {
  const cleaned = normalizeTaskVersions({
    items: [
      { version: at(5), tags: ["main_image"], status: "success" },
      { version: at(5), taskId: "重複同版", tags: ["main_image"] },
      { version: "垃圾", tags: ["main_image"] },
      { version: at(0), tags: ["main_image", "非法標籤", "main_image"] },
      "不是物件",
    ],
    selectedVersion: at(999),
  });
  assert.deepEqual(
    cleaned?.items.map((item) => item.version),
    [at(0), at(5)],
    "非法筆與重複版被丟，其餘保序（時序升序）",
  );
  assert.equal(cleaned?.selectedVersion, undefined, "懸空星標不收");
  assert.deepEqual(cleaned?.items[1].tags, ["main_image"]);
  assert.equal(normalizeTaskVersions({ items: [] }), undefined);
  assert.equal(normalizeTaskVersions(undefined), undefined);
  assert.equal(readTaskVersions(undefined), null);
  assert.equal(readTaskVersions({ taskVersions: { items: [{ version: "垃圾" }] } }), null);
});

test("雙白名單真往復：新增鍵經 toNodeMetadata(compactMetadataForAgent(...)) 逐鍵存活", () => {
  const set = selectTaskVersion(twoVersions(), at(5)).set;
  const metadata: CanvasNodeMetadata = { prompt: "雨夜码头", taskVersions: set };
  const snapshot = compactMetadataForAgent(metadata);
  assert.ok(snapshot, "上行快照不得為空");
  assert.deepEqual(snapshot.taskVersions, set, "上行端必須原樣透傳（漏傳＝還原後版本史消失）");

  const restored = toNodeMetadata(snapshot);
  assert.deepEqual(restored.taskVersions, set, "還原端必須逐鍵等值（含 selectedVersion）");
  // 真函式在還原後仍可用（不是死資料）
  assert.equal(readTaskVersions(restored)?.items.length, 2);
  assert.equal(selectedTaskVersionUrl(readTaskVersions(restored)), "https://cdn.example.com/v2.png");
});

test("雙白名單真往復：髒值在同一條通路裡真的被收斂（不是只靠清單條目）", () => {
  const dirty = {
    prompt: "x",
    taskVersions: {
      items: [
        { version: at(0), tags: ["main_image", "假標籤"], status: "不是狀態" },
        { version: "不是時間", tags: ["main_video"] },
      ],
      selectedVersion: at(0),
    },
  } as unknown as CanvasNodeMetadata;
  const restored = toNodeMetadata(compactMetadataForAgent(dirty));
  assert.deepEqual(restored.taskVersions, {
    items: [{ version: at(0), tags: ["main_image"] }],
    selectedVersion: at(0),
  });
});

test("值域宣告：TASK_TAGS 兩值（D37 字面），無第三套枚舉", () => {
  assert.deepEqual([...TASK_TAGS], ["main_image", "main_video"]);
});