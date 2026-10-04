// 任务版本（Version）＋标签（Tags）＋选中（Selected）行为测试（P1-9，对称差 D37）。
//
// 全部是**真函式行为断言**：真追加、真回填、真星标、真删除回退、真标签分组、
// 真 `toNodeMetadata(compactMetadataForAgent(...))` 往复；不含源码字串扫描
// （那种只算变更探针，不计入已验证）。
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

void _groupAlias; // 汇出存在但本档只用得到主要名称（避免未使用汇入）

/** 固定时戳（秒为单位，逐笔 +5s；避免同毫秒碰撞且让字典序可读）。 */
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

// ─────────────────────────────────────────── ① 重跑＝新版本，旧版本存活

test("同一格重跑：追加新版本，旧版本原样留在清单（不是覆盖）", () => {
  const first = appendTaskVersion(undefined, {
    version: at(0),
    taskId: "task-1",
    status: "loading",
    tags: ["main_image"],
  });
  assert.equal(first.accepted, true);
  assert.equal(first.set.items.length, 1);
  // 首笔自动上星标（本格要有采用稿；形状照 addShotCandidate 的首条自动上星）
  assert.equal(first.set.selectedVersion, at(0));

  // 回填同一笔任务的结果：版本不变、不产生新版本
  const filled = updateTaskVersion(first.set, at(0), { status: "success", url: "https://cdn.example.com/v1.png" });
  assert.equal(filled.updated, true);
  assert.equal(filled.set.items.length, 1, "同一任务的回填不得产生新版本");
  assert.equal(filled.set.items[0].version, at(0));
  assert.equal(filled.set.items[0].status, "success");
  assert.equal(filled.set.items[0].url, "https://cdn.example.com/v1.png");

  // 同一格重跑 → 第二笔任务
  const second = appendTaskVersion(filled.set, {
    version: at(5),
    taskId: "task-2",
    status: "success",
    tags: ["main_image"],
    url: "https://cdn.example.com/v2.png",
  });
  assert.equal(second.accepted, true);
  assert.equal(second.set.items.length, 2);
  assert.equal(second.set.items[0].version, at(0), "旧版本必须留著且可辨识");
  assert.equal(second.set.items[0].url, "https://cdn.example.com/v1.png");
  assert.equal(latestTaskVersion(second.set)?.version, at(5));
  assert.equal(second.set.selectedVersion, at(0), "后续追加不得抢星标（星标只走 selectTaskVersion）");

  // 同一任务重放＝duplicate（幂等），集合等值且旧版本零变动
  const replay = appendTaskVersion(second.set, { version: at(5), taskId: "task-2" });
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, "duplicate");
  assert.deepEqual(replay.set.items, second.set.items);
});

test("版本识别：时戳解析不出＝invalid（不编造版本），乱序追加仍按时序排列", () => {
  const bad = appendTaskVersion(undefined, { version: "不是时间", tags: ["main_image"] });
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, "invalid");
  assert.deepEqual(bad.set.items, []);

  // 先追加较晚的、再追加较早的 → 清单仍按时序升序（末条＝最新）
  const late = appendTaskVersion(undefined, { version: at(30), tags: ["main_image"] });
  const early = appendTaskVersion(late.set, { version: at(10), tags: ["main_image"] });
  assert.deepEqual(
    early.set.items.map((item) => item.version),
    [at(10), at(30)],
  );
  assert.equal(latestTaskVersion(early.set)?.version, at(30));
  // 正规化：带时区的输入也收敛成 UTC ISO（字典序＝时间序）
  assert.equal(normalizeTaskVersion("2026-09-29T10:00:00+08:00"), "2026-09-29T02:00:00.000Z");
});

test("上限：塞不下明说 full（不静默裁掉旧版本）", () => {
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
  assert.deepEqual(overflow.set.items, before.items, "满了必须原样退回（不得静默裁旧）");
  assert.equal(overflow.set.items[0].version, at(0), "最早的版本仍在");

  // 腾位子的唯一手段＝明确删除；删完就能再追加
  const freed = removeTaskVersion(before, at(0));
  assert.equal(freed.removed, true);
  assert.equal(appendTaskVersion(freed.set, { version: at(MAX_TASK_VERSIONS_PER_NODE), tags: ["main_image"] }).accepted, true);
});

// ─────────────────────────────────────────── ② Tags：推导、清洗、查询、分组

test("标签推导：照现场既有 kind 词汇收敛，未知值不猜（不回 main_image）", () => {
  assert.equal(taskTagForKind("image"), "main_image");
  assert.equal(taskTagForKind("image_generate"), "main_image");
  assert.equal(taskTagForKind("image_edit"), "main_image");
  assert.equal(taskTagForKind("video"), "main_video");
  assert.equal(taskTagForKind("video_generate"), "main_video");
  assert.equal(taskTagForKind("main_image"), "main_image", "D37 字面原样可宣告");
  assert.equal(taskTagForKind("main_video"), "main_video");
  assert.equal(taskTagForKind("tts"), null, "语义上不是主图/主片：不给标签");
  assert.equal(taskTagForKind("avatar"), null);
  assert.equal(taskTagForKind("lipsync"), null);
  assert.equal(taskTagForKind("mystery_kind"), null, "未知值不收敛（猜错会污染分组）");
  assert.equal(taskTagForKind(""), null);
  assert.equal(taskTagForKind(42), null);
  assert.equal(taskTagForKind(undefined), null);
});

test("标签清洗：未知值丢弃、去重保序；空＝[]（分组是总函式）", () => {
  assert.deepEqual(normalizeTaskTags(["main_video", "main_image", "main_image", "乱七八糟", 7, null]), [
    "main_video",
    "main_image",
  ]);
  assert.deepEqual(normalizeTaskTags(undefined), []);
  assert.deepEqual(normalizeTaskTags("main_image"), [], "非阵列不收（不代为包成单元素）");
});

test("标签查询／分组：一格先出图后出片 → 两组；跨格查询只命中带该标签的版本", () => {
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
  // 分组结果：只出非空的组，顺序＝值域序（稳定可比对）
  const groups = groupTaskVersionsByTag(withVideo.set);
  assert.deepEqual(
    groups.map((group) => [group.tag, group.items.length]),
    [
      ["main_image", 1],
      ["main_video", 1],
    ],
  );
  assert.deepEqual(groupTaskVersionsByTag(undefined), []);

  // 跨格查询
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
  assert.deepEqual(taskVersionsWithTag(nodes, "bogus" as TaskTag), [], "值域外标签零命中（不臆造）");
  assert.deepEqual(
    taskVersionsWithTag(nodes, "main_image").map((hit) => hit.nodeId),
    ["n1", "n2"],
    "没有该键的节点零命中",
  );
});

// ─────────────────────────────────────────── ③ Selected：标记与删除回退

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

test("Selected：只有成员可被选中（非成员不制造悬空星标）", () => {
  const set = twoVersions();
  const hit = selectTaskVersion(set, at(5));
  assert.equal(hit.selected, true);
  assert.equal(hit.set.selectedVersion, at(5));
  assert.equal(selectedTaskVersion(hit.set)?.taskId, "task-2");
  assert.equal(selectedTaskVersionUrl(hit.set), "https://cdn.example.com/v2.png", "选中者就是采用稿素材");

  const miss = selectTaskVersion(set, at(999));
  assert.equal(miss.selected, false);
  assert.equal(miss.set.selectedVersion, at(0), "未命中不得改星标");
  assert.notEqual(miss.set, set, "拒绝时回等值新物件（呼叫端拿不到可误改的旧参考）");

  const bad = selectTaskVersion(set, "不是时间");
  assert.equal(bad.selected, false);
  assert.equal(bad.set.selectedVersion, at(0));
});

test("删除选中者：回退剩余第一条（同 reducer 批次主图 kept[0]／removeShotCandidate items[0]）", () => {
  const selected = selectTaskVersion(twoVersions(), at(5)).set;
  const removed = removeTaskVersion(selected, at(5));
  assert.equal(removed.removed, true);
  assert.deepEqual(
    removed.set.items.map((item) => item.version),
    [at(0)],
  );
  assert.equal(removed.set.selectedVersion, at(0), "删掉星标者 → 回退剩余第一条");
  assert.equal(selectedTaskVersionUrl(removed.set), "https://cdn.example.com/v1.png");

  // 删非星标者：星标不动
  const keepSelected = removeTaskVersion(selected, at(0));
  assert.equal(keepSelected.set.selectedVersion, at(5));
  assert.equal(keepSelected.set.items.length, 1);

  // 全删光：没有 selectedVersion（集合空 → metadata patch 收成省略键）
  const emptied = removeTaskVersion(keepSelected.set, at(5));
  assert.deepEqual(emptied.set.items, []);
  assert.equal(emptied.set.selectedVersion, undefined);
  assert.deepEqual(taskVersionsMetadata(emptied.set), {}, "空集合不写空壳键");

  // 找不到该版：不改（等值新物件）
  const miss = removeTaskVersion(selected, at(123));
  assert.equal(miss.removed, false);
  assert.equal(miss.set.selectedVersion, at(5));
  assert.equal(miss.set.items.length, 2);
});

test("查询端：taskVersionOf／selectedTaskVersion／latestTaskVersion 对缺席诚实回 null", () => {
  const set = twoVersions();
  assert.equal(taskVersionOf(set, at(0))?.taskId, "task-1");
  assert.equal(taskVersionOf(set, at(999)), null);
  assert.equal(selectedTaskVersion(undefined), null);
  assert.equal(selectedTaskVersionUrl(null), null);
  assert.equal(latestTaskVersion(undefined), null);
});

// ─────────────────────────────────────────── ④ 清洗（读取端）与双白名单真往复

test("清洗：逐笔丢非法、同版去重、selectedVersion 非成员即不收、空集合＝省略键", () => {
  const cleaned = normalizeTaskVersions({
    items: [
      { version: at(5), tags: ["main_image"], status: "success" },
      { version: at(5), taskId: "重复同版", tags: ["main_image"] },
      { version: "垃圾", tags: ["main_image"] },
      { version: at(0), tags: ["main_image", "非法标签", "main_image"] },
      "不是物件",
    ],
    selectedVersion: at(999),
  });
  assert.deepEqual(
    cleaned?.items.map((item) => item.version),
    [at(0), at(5)],
    "非法笔与重复版被丢，其余保序（时序升序）",
  );
  assert.equal(cleaned?.selectedVersion, undefined, "悬空星标不收");
  assert.deepEqual(cleaned?.items[1].tags, ["main_image"]);
  assert.equal(normalizeTaskVersions({ items: [] }), undefined);
  assert.equal(normalizeTaskVersions(undefined), undefined);
  assert.equal(readTaskVersions(undefined), null);
  assert.equal(readTaskVersions({ taskVersions: { items: [{ version: "垃圾" }] } }), null);
});

test("双白名单真往复：新增键经 toNodeMetadata(compactMetadataForAgent(...)) 逐键存活", () => {
  const set = selectTaskVersion(twoVersions(), at(5)).set;
  const metadata: CanvasNodeMetadata = { prompt: "雨夜码头", taskVersions: set };
  const snapshot = compactMetadataForAgent(metadata);
  assert.ok(snapshot, "上行快照不得为空");
  assert.deepEqual(snapshot.taskVersions, set, "上行端必须原样透传（漏传＝还原后版本史消失）");

  const restored = toNodeMetadata(snapshot);
  assert.deepEqual(restored.taskVersions, set, "还原端必须逐键等值（含 selectedVersion）");
  // 真函式在还原后仍可用（不是死资料）
  assert.equal(readTaskVersions(restored)?.items.length, 2);
  assert.equal(selectedTaskVersionUrl(readTaskVersions(restored)), "https://cdn.example.com/v2.png");
});

test("双白名单真往复：脏值在同一条通路里真的被收敛（不是只靠清单条目）", () => {
  const dirty = {
    prompt: "x",
    taskVersions: {
      items: [
        { version: at(0), tags: ["main_image", "假标签"], status: "不是状态" },
        { version: "不是时间", tags: ["main_video"] },
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

test("值域宣告：TASK_TAGS 两值（D37 字面），无第三套枚举", () => {
  assert.deepEqual([...TASK_TAGS], ["main_image", "main_video"]);
});