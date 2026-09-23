import test from "node:test";
import assert from "node:assert/strict";

import {
  LINEAGE_DEFAULT_DEPTH,
  MAX_LINEAGE_PARENTS,
  buildLineageTree,
  cleanLineageHandle,
  flattenLineageTree,
  historyEntryHandles,
  mergeLineageIntoHost,
  normalizeLineageLink,
  normalizeLineageLinks,
  parentsFromReferences,
  parseLineageFields,
  readHostLineage,
  serializeLineageFields,
  type LineageLink,
  type LineagePool,
  type LineageRecordView,
} from "./lineage.ts";
import { normalizeHistoryEntry, type HistoryEntry } from "./history-types.ts";

// ─────────────────────────────────────────── 序列化形態與往返

const T0 = "2026-09-22T00:00:00.000Z";

function link(overrides: Partial<LineageLink> & Pick<LineageLink, "kind">): LineageLink {
  return { at: T0, ...overrides };
}

test("血統序列化往返：寫入形態與讀回形態逐字段等價", () => {
  const host = {
    lineage: [
      link({ kind: "derivation", jobId: "task-1" }),
      link({ kind: "reference", assetId: "card-a" }),
      link({ kind: "rerun", jobId: "task-2", nodeId: "n-3" }),
    ],
    lineageTruncated: true,
  };
  const text = serializeLineageFields(host);
  const parsed = parseLineageFields(text);
  assert.ok(parsed);
  assert.deepEqual(parsed, host);
});

test("血統反序列化：非法 JSON / 非物件 / 空登記一律 null，不捏造", () => {
  assert.equal(parseLineageFields("not json"), null);
  assert.equal(parseLineageFields("[]"), null);
  assert.equal(parseLineageFields("{}"), null);
  assert.equal(parseLineageFields("{\"lineage\":[]}"), null);
});

// ─────────────────────────────────────────── 清洗收口

test("單條清洗：kind 白名單、把手全缺丟、at 缺省補當前時間", () => {
  assert.equal(normalizeLineageLink({ kind: "teleport", jobId: "t1", at: T0 }), null);
  assert.equal(normalizeLineageLink({ kind: "rerun", at: T0 }), null);
  assert.equal(normalizeLineageLink(null), null);
  assert.equal(normalizeLineageLink({ kind: "rerun", jobId: "  ", at: T0 }), null);
  const fixed = normalizeLineageLink({ kind: "reference", assetId: "a1" });
  assert.ok(fixed);
  assert.equal(fixed.kind, "reference");
  assert.ok(Date.parse(fixed.at) > 0);
  // at 非法字串收斂為可解析時間（不讓壞數據卡死抽屜渲染）。
  const badAt = normalizeLineageLink({ kind: "rerun", jobId: "j1", at: "not-a-date" });
  assert.ok(badAt && Number.isFinite(Date.parse(badAt.at)));
});

test("把手清洗：帶空白/控制字元/超 160 字元的灌串直接丟棄", () => {
  assert.equal(cleanLineageHandle("has space"), undefined);
  assert.equal(cleanLineageHandle("tab\there"), undefined);
  assert.equal(cleanLineageHandle("x".repeat(161)), undefined);
  assert.equal(cleanLineageHandle("ok-id_1:v2"), "ok-id_1:v2");
});

test("缺 parent 不炸：null/非陣列/非法條目混入，只留合法", () => {
  assert.deepEqual(normalizeLineageLinks(undefined), { parents: [], truncated: false });
  assert.deepEqual(normalizeLineageLinks("nope"), { parents: [], truncated: false });
  const mixed = normalizeLineageLinks([
    { kind: "rerun", jobId: "ok", at: T0 },
    { kind: "nope", jobId: "bad" },
    null,
    42,
    { kind: "reference", assetId: "also-ok", at: T0 },
  ]);
  assert.equal(mixed.parents.length, 2);
  assert.equal(mixed.truncated, false);
});

// ─────────────────────────────────────────── 上限截尾（顯式標註）

test("parents 上限 5：超過截尾並顯式標註截斷", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ kind: "reference" as const, jobId: `j${i}`, at: T0 }));
  const result = normalizeLineageLinks(many);
  assert.equal(result.parents.length, MAX_LINEAGE_PARENTS);
  assert.equal(result.truncated, true);
  // 恰好 5 個不誤標。
  const exact = normalizeLineageLinks(many.slice(0, 5));
  assert.equal(exact.parents.length, 5);
  assert.equal(exact.truncated, false);
});

// ─────────────────────────────────────────── 冪等合併（回溯補丁重跑必恆等）

test("mergeLineageIntoHost 冪等：重複登記同一 parent 結果逐字段恆等", () => {
  const first = mergeLineageIntoHost(null, [link({ kind: "rerun", jobId: "src-1" })]);
  assert.ok(first);
  const again = mergeLineageIntoHost(first, [link({ kind: "rerun", jobId: "src-1" })]);
  assert.ok(again);
  assert.deepEqual(again, first);
  // 補丁重跑（同一事實再餵一次）不雙登記——回溯補丁幂等測試的數據面等價物。
  const thrice = mergeLineageIntoHost(again, [link({ kind: "rerun", jobId: "src-1" })]);
  assert.equal(thrice?.lineage?.length, 1);
});

test("mergeLineageIntoHost：空對空不落欄位；截斷標記只由溢出產生", () => {
  assert.equal(mergeLineageIntoHost(null, []), null);
  assert.equal(mergeLineageIntoHost(undefined, []), null);
  const merged = mergeLineageIntoHost(null, Array.from({ length: 7 }, (_, i) => link({ kind: "reference", jobId: `j${i}` })));
  assert.equal(merged?.lineage?.length, 5);
  assert.equal(merged?.lineageTruncated, true);
  assert.equal(mergeLineageIntoHost(null, [link({ kind: "reference", jobId: "a" })])?.lineageTruncated, undefined);
});

// ─────────────────────────────────────────── 掛鉤提取尺

test("parentsFromReferences：源任務記 derivation、產物記 reference、裸上傳不登記", () => {
  const links = parentsFromReferences([
    { sourceGenerationId: "job-src", sourceResultId: "art-src" },
    { sourceResultId: "art-only" },
    {},
    { sourceGenerationId: "   " },
  ], T0);
  assert.deepEqual(links, [
    { kind: "derivation", jobId: "job-src", at: T0 },
    { kind: "reference", assetId: "art-only", at: T0 },
  ]);
  assert.deepEqual(parentsFromReferences(undefined, T0), []);
});

test("historyEntryHandles：jobId 取 taskId 優先，歷史把手與產物 id 進 assetIds", () => {
  const handles = historyEntryHandles({
    id: "82-1700",
    taskId: "task-9",
    results: [{ resultId: "art-1" }, { resultId: null }, {}],
  });
  assert.equal(handles.jobId, "task-9");
  assert.deepEqual(handles.assetIds, ["history-82-1700", "art-1"]);
  const sync = historyEntryHandles({ id: "82-1700", results: [] });
  // 同步直出記錄不是 job：沒有 jobId 把手，只有 `history-${id}` 資產把手。
  assert.equal(sync.jobId, undefined);
  assert.deepEqual(sync.assetIds, ["history-82-1700"]);
});

// ─────────────────────────────────────────── 鏈條構建：多級/自引用/兩態

function view(overrides: Partial<LineageRecordView> & Pick<LineageRecordView, "selfHandles" | "label">): LineageRecordView {
  return { thumbnailUrl: null, timeMs: null, ...overrides };
}

function poolOf(records: LineageRecordView[]): LineagePool {
  return {
    find(jobId, assetId) {
      for (const record of records) {
        if (jobId && record.selfHandles.jobId === jobId) return record;
        if (assetId && record.selfHandles.assetId === assetId) return record;
      }
      return null;
    },
  };
}

test("多級鏈：三級祖先逐級解析，深度超默認 3 層標 pruned 不誤報", () => {
  const level3 = view({ selfHandles: { jobId: "L3" }, label: "三级", lineage: [link({ kind: "derivation", jobId: "L4" })] });
  const level2 = view({ selfHandles: { jobId: "L2" }, label: "二级", lineage: [link({ kind: "derivation", jobId: "L3" })] });
  const level1 = view({ selfHandles: { jobId: "L1" }, label: "一级", lineage: [link({ kind: "rerun", jobId: "L2" })] });
  const root = view({ selfHandles: { jobId: "R" }, label: "根", lineage: [link({ kind: "rerun", jobId: "L1" })] });
  const pool = poolOf([root, level1, level2, level3]);
  const { tree, rootHasLineage } = buildLineageTree(root, pool);
  assert.equal(rootHasLineage, true);
  assert.equal(tree.children.length, 1);
  const first = tree.children[0];
  assert.equal(first.status, "resolved");
  assert.equal(first.label, "一级");
  const second = first.children[0];
  assert.equal(second.label, "二级");
  const third = second.children[0];
  assert.equal(third.label, "三级");
  // 默認只展開 3 層：第四級以 pruned 表態，絕不誤標「已刪除」。
  assert.equal(third.children.length, 1);
  assert.equal(third.children[0].status, "pruned");
  assert.equal(third.children[0].depth, LINEAGE_DEFAULT_DEPTH + 1);
  // 繼續向上：maxDepth 加大後第四級解析出來——L4 從不在池中，曾有引用＝「已刪除」態。
  const deeper = buildLineageTree(root, pool, { maxDepth: LINEAGE_DEFAULT_DEPTH + 1 });
  const grown = deeper.tree.children[0].children[0].children[0].children[0];
  assert.equal(grown.status, "deleted");
});

test("已刪除與來源不明是两个態：把手查無＝已刪除；本體無登記＝來源不明", () => {
  // 態一：登記了把手但池裡查無（曾有引用）。
  const hostDeleted = view({ selfHandles: { jobId: "R" }, label: "r", lineage: [link({ kind: "derivation", jobId: "gone" })] });
  const treeDeleted = buildLineageTree(hostDeleted, poolOf([hostDeleted]));
  assert.equal(treeDeleted.tree.children[0].status, "deleted");
  assert.equal(treeDeleted.tree.children[0].jumpTo?.jobId, "gone");
  // 態二：本體完全沒有血統登記 → rootHasLineage=false，抽屜顯示「來源不明」。
  const hostUnknown = view({ selfHandles: { jobId: "R2" }, label: "r2" });
  const treeUnknown = buildLineageTree(hostUnknown, poolOf([hostUnknown]));
  assert.equal(treeUnknown.rootHasLineage, false);
  assert.equal(treeUnknown.tree.children.length, 0);
  // 兩態不混用：已刪除的鏈沒有把「來源不明」蓋上去，反之亦然。
  assert.notEqual(treeDeleted.rootHasLineage, treeUnknown.rootHasLineage);
});

test("自引用：parent 指回本體標 self，不遞歸不爆炸", () => {
  const host = view({ selfHandles: { jobId: "me" }, label: "me", lineage: [link({ kind: "rerun", jobId: "me" })] });
  const { tree } = buildLineageTree(host, poolOf([host]));
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].status, "self");
});

test("成環：A→B→A 的環在重複把手處標 cycle 停止", () => {
  const a = view({ selfHandles: { jobId: "A" }, label: "A", lineage: [link({ kind: "derivation", jobId: "B" })] });
  const b = view({ selfHandles: { jobId: "B" }, label: "B", lineage: [link({ kind: "derivation", jobId: "A" })] });
  const { tree } = buildLineageTree(a, poolOf([a, b]));
  const bNode = tree.children[0];
  assert.equal(bNode.status, "resolved");
  assert.equal(bNode.children[0].status, "cycle");
});

test("節點預算：病態寬鏈在預算耗盡處標 pruned，不誤報已刪除", () => {
  const wideLinks = Array.from({ length: 12 }, (_, i) => link({ kind: "reference", jobId: `w${i}` }));
  const root = view({ selfHandles: { jobId: "R" }, label: "r", lineage: wideLinks });
  const pool = poolOf([root]);
  const { tree } = buildLineageTree(root, pool, { maxNodes: 4 });
  const prunedCount = tree.children.filter((child) => child.status === "pruned").length;
  assert.ok(prunedCount >= 1);
  assert.equal(tree.children.some((child) => child.status === "deleted" && !child.label), false);
});

test("flattenLineageTree：超出可見深度的鏈收成一時佔位行", () => {
  const deep = view({ selfHandles: { jobId: "D2" }, label: "d2" });
  const mid = view({ selfHandles: { jobId: "D1" }, label: "d1", lineage: [link({ kind: "derivation", jobId: "D2" })] });
  const root = view({ selfHandles: { jobId: "D0" }, label: "d0", lineage: [link({ kind: "derivation", jobId: "D1" })] });
  const { tree } = buildLineageTree(root, poolOf([root, mid, deep]), { maxDepth: 5 });
  const rows = flattenLineageTree(tree, 1);
  const placeholder = rows.find((row) => row.label === "更深鏈條未展開");
  assert.ok(placeholder);
  assert.ok(rows.some((row) => row.label === "d1"));
  assert.equal(rows.some((row) => row.label === "d2"), false);
});

// ─────────────────────────────────────────── 宿主欄位收口

test("normalizeHistoryEntry 血統透傳：合法保留、非法丟、截尾標記落數據", () => {
  const base = { id: "82-1", generatedAt: 1700000000000, prompt: "p", results: [] };
  const ok = normalizeHistoryEntry({
    ...base,
    lineage: [
      { kind: "rerun", jobId: "task-a", at: T0 },
      { kind: "bogus", jobId: "x", at: T0 },
    ],
  }, "server");
  assert.ok(ok);
  assert.deepEqual(ok.lineage, [{ kind: "rerun", jobId: "task-a", at: T0 }]);
  assert.equal(ok.lineageTruncated, undefined);
  const over = normalizeHistoryEntry({
    ...base,
    lineage: Array.from({ length: 9 }, (_, i) => ({ kind: "reference", jobId: `j${i}`, at: T0 })),
  }, "server");
  assert.equal(over?.lineage?.length, MAX_LINEAGE_PARENTS);
  assert.equal(over?.lineageTruncated, true);
  const none = normalizeHistoryEntry(base, "server");
  assert.equal(none?.lineage, undefined);
  assert.equal(none?.lineageTruncated, undefined);
});

test("讀宿主欄位族：未登記返回 null（來源不明判據），登記了給清洗結果", () => {
  assert.equal(readHostLineage(undefined), null);
  assert.equal(readHostLineage({}), null);
  assert.deepEqual(readHostLineage({ lineage: [] }), { parents: [], truncated: false });
  const host = { lineage: [link({ kind: "rerun", jobId: "x" })], lineageTruncated: true };
  const read = readHostLineage(host);
  assert.equal(read?.truncated, true);
});

// 防跑偏守衛：宿主欄位族只給歷史/卡本體用，型別層面與畫布節點 metadata 無關。
test("血統欄位族注釋即契約：LineageHostFields 不含畫布節點欄位", () => {
  const sample: LineageRecordView = view({ selfHandles: { jobId: "j" }, label: "l" });
  const keys = Object.keys(sample);
  assert.equal(keys.includes("nodeId"), false);
  assert.equal(keys.includes("metadata"), false);
});

// 端到端口徑的最小機械證明：job 帶參考圖 → 產物歷史登記 parents → 溯源鏈對得上一條生成記錄。
test("端到端鏈形：生成登記（掛鉤 a）→ 落宿主欄位 → 讀時建鏈跳轉", () => {
  const sourceEntry: HistoryEntry = {
    id: "task-src",
    taskId: "task-src",
    prompt: "源头",
    generatedAt: 1700000000000,
    results: [{ provider: "image_tinchak", modelId: "m", image: null, imageUrl: "https://x/src.png", resultId: "art-src" }],
    source: "server",
  };
  // 掛鉤 a：第二次生成帶了第一次的產物作參考圖。
  const parents = parentsFromReferences([{ sourceGenerationId: "task-src", sourceResultId: "art-src" }], T0);
  const derivedEntry = { ...sourceEntry, id: "task-child", taskId: "task-child", prompt: "衍生", ...(mergeLineageIntoHost(null, parents) ?? {}) };
  assert.equal(derivedEntry.lineage?.[0].kind, "derivation");
  // 讀時建鏈：孩子能跳回父親。
  const childView = view({
    selfHandles: { jobId: "task-child" },
    label: derivedEntry.prompt,
    lineage: derivedEntry.lineage,
  });
  const parentView = view({ selfHandles: { jobId: "task-src" }, label: sourceEntry.prompt, thumbnailUrl: "https://x/src.png" });
  const { tree } = buildLineageTree(childView, poolOf([childView, parentView]));
  assert.equal(tree.children[0].status, "resolved");
  assert.equal(tree.children[0].jumpTo?.jobId, "task-src");
  assert.equal(tree.children[0].thumbnailUrl, "https://x/src.png");
});
// ─────────────────────────────────────────── 回溯補丁幂等（tools/backfill-lineage）

test("回溯補丁幂等：同一記錄重複補丁不雙登記（重跑=恆等）", async () => {
  const { lineageCandidatesFromEntry } = await import("../../tools/backfill-lineage.ts");
  const legacy: HistoryEntry = {
    id: "82-legacy",
    prompt: "存量",
    generatedAt: 1700000000000,
    results: [],
    source: "server",
    retryOfTaskId: "task-orig",
    workflow: { referenceImages: [{ sourceGenerationId: "task-src", name: "r", role: "general" }] },
  };
  const once = mergeLineageIntoHost(null, lineageCandidatesFromEntry(legacy));
  assert.ok(once?.lineage);
  assert.equal(once.lineage.length, 2); // derivation(task-src) + rerun(task-orig)
  // 補丁重跑：對「已補過的宿主」再餵同一批候選——條目數與內容逐字段恆等。
  const twice = mergeLineageIntoHost(once, lineageCandidatesFromEntry(legacy));
  assert.deepEqual(twice, once);
});
