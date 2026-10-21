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

// ─────────────────────────────────────────── 序列化形态与往返

const T0 = "2026-09-22T00:00:00.000Z";

function link(overrides: Partial<LineageLink> & Pick<LineageLink, "kind">): LineageLink {
  return { at: T0, ...overrides };
}

test("血统序列化往返：写入形态与读回形态逐字段等价", () => {
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

test("血统反序列化：非法 JSON / 非物件 / 空登记一律 null，不捏造", () => {
  assert.equal(parseLineageFields("not json"), null);
  assert.equal(parseLineageFields("[]"), null);
  assert.equal(parseLineageFields("{}"), null);
  assert.equal(parseLineageFields("{\"lineage\":[]}"), null);
});

// ─────────────────────────────────────────── 清洗收口

test("单条清洗：kind 白名单、把手全缺丢、at 缺省补当前时间", () => {
  assert.equal(normalizeLineageLink({ kind: "teleport", jobId: "t1", at: T0 }), null);
  assert.equal(normalizeLineageLink({ kind: "rerun", at: T0 }), null);
  assert.equal(normalizeLineageLink(null), null);
  assert.equal(normalizeLineageLink({ kind: "rerun", jobId: "  ", at: T0 }), null);
  const fixed = normalizeLineageLink({ kind: "reference", assetId: "a1" });
  assert.ok(fixed);
  assert.equal(fixed.kind, "reference");
  assert.ok(Date.parse(fixed.at) > 0);
  // at 非法字串收敛为可解析时间（不让坏数据卡死抽屉渲染）。
  const badAt = normalizeLineageLink({ kind: "rerun", jobId: "j1", at: "not-a-date" });
  assert.ok(badAt && Number.isFinite(Date.parse(badAt.at)));
});

test("把手清洗：带空白/控制字元/超 160 字元的灌串直接丢弃", () => {
  assert.equal(cleanLineageHandle("has space"), undefined);
  assert.equal(cleanLineageHandle("tab\there"), undefined);
  assert.equal(cleanLineageHandle("x".repeat(161)), undefined);
  assert.equal(cleanLineageHandle("ok-id_1:v2"), "ok-id_1:v2");
});

test("缺 parent 不炸：null/非阵列/非法条目混入，只留合法", () => {
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

// ─────────────────────────────────────────── 上限截尾（显式标注）

test("parents 上限 5：超过截尾并显式标注截断", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ kind: "reference" as const, jobId: `j${i}`, at: T0 }));
  const result = normalizeLineageLinks(many);
  assert.equal(result.parents.length, MAX_LINEAGE_PARENTS);
  assert.equal(result.truncated, true);
  // 恰好 5 个不误标。
  const exact = normalizeLineageLinks(many.slice(0, 5));
  assert.equal(exact.parents.length, 5);
  assert.equal(exact.truncated, false);
});

// ─────────────────────────────────────────── 幂等合并（回溯补丁重跑必恒等）

test("mergeLineageIntoHost 幂等：重复登记同一 parent 结果逐字段恒等", () => {
  const first = mergeLineageIntoHost(null, [link({ kind: "rerun", jobId: "src-1" })]);
  assert.ok(first);
  const again = mergeLineageIntoHost(first, [link({ kind: "rerun", jobId: "src-1" })]);
  assert.ok(again);
  assert.deepEqual(again, first);
  // 补丁重跑（同一事实再喂一次）不双登记——回溯补丁幂等测试的数据面等价物。
  const thrice = mergeLineageIntoHost(again, [link({ kind: "rerun", jobId: "src-1" })]);
  assert.equal(thrice?.lineage?.length, 1);
});

test("mergeLineageIntoHost：空对空不落栏位；截断标记只由溢出产生", () => {
  assert.equal(mergeLineageIntoHost(null, []), null);
  assert.equal(mergeLineageIntoHost(undefined, []), null);
  const merged = mergeLineageIntoHost(null, Array.from({ length: 7 }, (_, i) => link({ kind: "reference", jobId: `j${i}` })));
  assert.equal(merged?.lineage?.length, 5);
  assert.equal(merged?.lineageTruncated, true);
  assert.equal(mergeLineageIntoHost(null, [link({ kind: "reference", jobId: "a" })])?.lineageTruncated, undefined);
});

// ─────────────────────────────────────────── 挂钩提取尺

test("parentsFromReferences：源任务记 derivation、产物记 reference、裸上传不登记", () => {
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

test("historyEntryHandles：jobId 取 taskId 优先，历史把手与产物 id 进 assetIds", () => {
  const handles = historyEntryHandles({
    id: "82-1700",
    taskId: "task-9",
    results: [{ resultId: "art-1" }, { resultId: null }, {}],
  });
  assert.equal(handles.jobId, "task-9");
  assert.deepEqual(handles.assetIds, ["history-82-1700", "art-1"]);
  const sync = historyEntryHandles({ id: "82-1700", results: [] });
  // 同步直出记录不是 job：没有 jobId 把手，只有 `history-${id}` 资产把手。
  assert.equal(sync.jobId, undefined);
  assert.deepEqual(sync.assetIds, ["history-82-1700"]);
});

// ─────────────────────────────────────────── 链条构建：多级/自引用/两态

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

test("多级链：三级祖先逐级解析，深度超默认 3 层标 pruned 不误报", () => {
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
  // 默认只展开 3 层：第四级以 pruned 表态，绝不误标「已删除」。
  assert.equal(third.children.length, 1);
  assert.equal(third.children[0].status, "pruned");
  assert.equal(third.children[0].depth, LINEAGE_DEFAULT_DEPTH + 1);
  // 继续向上：maxDepth 加大后第四级解析出来——L4 从不在池中，曾有引用＝「已删除」态。
  const deeper = buildLineageTree(root, pool, { maxDepth: LINEAGE_DEFAULT_DEPTH + 1 });
  const grown = deeper.tree.children[0].children[0].children[0].children[0];
  assert.equal(grown.status, "deleted");
});

test("已删除与来源不明是两个态：把手查无＝已删除；本体无登记＝来源不明", () => {
  // 态一：登记了把手但池里查无（曾有引用）。
  const hostDeleted = view({ selfHandles: { jobId: "R" }, label: "r", lineage: [link({ kind: "derivation", jobId: "gone" })] });
  const treeDeleted = buildLineageTree(hostDeleted, poolOf([hostDeleted]));
  assert.equal(treeDeleted.tree.children[0].status, "deleted");
  assert.equal(treeDeleted.tree.children[0].jumpTo?.jobId, "gone");
  // 态二：本体完全没有血统登记 → rootHasLineage=false，抽屉显示「来源不明」。
  const hostUnknown = view({ selfHandles: { jobId: "R2" }, label: "r2" });
  const treeUnknown = buildLineageTree(hostUnknown, poolOf([hostUnknown]));
  assert.equal(treeUnknown.rootHasLineage, false);
  assert.equal(treeUnknown.tree.children.length, 0);
  // 两态不混用：已删除的链没有把「来源不明」盖上去，反之亦然。
  assert.notEqual(treeDeleted.rootHasLineage, treeUnknown.rootHasLineage);
});

test("自引用：parent 指回本体标 self，不递归不爆炸", () => {
  const host = view({ selfHandles: { jobId: "me" }, label: "me", lineage: [link({ kind: "rerun", jobId: "me" })] });
  const { tree } = buildLineageTree(host, poolOf([host]));
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].status, "self");
});

test("成环：A→B→A 的环在重复把手处标 cycle 停止", () => {
  const a = view({ selfHandles: { jobId: "A" }, label: "A", lineage: [link({ kind: "derivation", jobId: "B" })] });
  const b = view({ selfHandles: { jobId: "B" }, label: "B", lineage: [link({ kind: "derivation", jobId: "A" })] });
  const { tree } = buildLineageTree(a, poolOf([a, b]));
  const bNode = tree.children[0];
  assert.equal(bNode.status, "resolved");
  assert.equal(bNode.children[0].status, "cycle");
});

test("节点预算：病态宽链在预算耗尽处标 pruned，不误报已删除", () => {
  const wideLinks = Array.from({ length: 12 }, (_, i) => link({ kind: "reference", jobId: `w${i}` }));
  const root = view({ selfHandles: { jobId: "R" }, label: "r", lineage: wideLinks });
  const pool = poolOf([root]);
  const { tree } = buildLineageTree(root, pool, { maxNodes: 4 });
  const prunedCount = tree.children.filter((child) => child.status === "pruned").length;
  assert.ok(prunedCount >= 1);
  assert.equal(tree.children.some((child) => child.status === "deleted" && !child.label), false);
});

test("flattenLineageTree：超出可见深度的链收成一时占位行", () => {
  const deep = view({ selfHandles: { jobId: "D2" }, label: "d2" });
  const mid = view({ selfHandles: { jobId: "D1" }, label: "d1", lineage: [link({ kind: "derivation", jobId: "D2" })] });
  const root = view({ selfHandles: { jobId: "D0" }, label: "d0", lineage: [link({ kind: "derivation", jobId: "D1" })] });
  const { tree } = buildLineageTree(root, poolOf([root, mid, deep]), { maxDepth: 5 });
  const rows = flattenLineageTree(tree, 1);
  const placeholder = rows.find((row) => row.label === "更深链条未展开");
  assert.ok(placeholder);
  assert.ok(rows.some((row) => row.label === "d1"));
  assert.equal(rows.some((row) => row.label === "d2"), false);
});

// ─────────────────────────────────────────── 宿主栏位收口

test("normalizeHistoryEntry 血统透传：合法保留、非法丢、截尾标记落数据", () => {
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

test("读宿主栏位族：未登记返回 null（来源不明判据），登记了给清洗结果", () => {
  assert.equal(readHostLineage(undefined), null);
  assert.equal(readHostLineage({}), null);
  assert.deepEqual(readHostLineage({ lineage: [] }), { parents: [], truncated: false });
  const host = { lineage: [link({ kind: "rerun", jobId: "x" })], lineageTruncated: true };
  const read = readHostLineage(host);
  assert.equal(read?.truncated, true);
});

// 防跑偏守卫：宿主栏位族只给历史/卡本体用，型别层面与画布节点 metadata 无关。
test("血统栏位族注释即契约：LineageHostFields 不含画布节点栏位", () => {
  const sample: LineageRecordView = view({ selfHandles: { jobId: "j" }, label: "l" });
  const keys = Object.keys(sample);
  assert.equal(keys.includes("nodeId"), false);
  assert.equal(keys.includes("metadata"), false);
});

// 端到端口径的最小机械证明：job 带参考图 → 产物历史登记 parents → 溯源链对得上一条生成记录。
test("端到端链形：生成登记（挂钩 a）→ 落宿主栏位 → 读时建链跳转", () => {
  const sourceEntry: HistoryEntry = {
    id: "task-src",
    taskId: "task-src",
    prompt: "源头",
    generatedAt: 1700000000000,
    results: [{ provider: "image_tinchak", modelId: "m", image: null, imageUrl: "https://x/src.png", resultId: "art-src" }],
    source: "server",
  };
  // 挂钩 a：第二次生成带了第一次的产物作参考图。
  const parents = parentsFromReferences([{ sourceGenerationId: "task-src", sourceResultId: "art-src" }], T0);
  const derivedEntry = { ...sourceEntry, id: "task-child", taskId: "task-child", prompt: "衍生", ...(mergeLineageIntoHost(null, parents) ?? {}) };
  assert.equal(derivedEntry.lineage?.[0].kind, "derivation");
  // 读时建链：孩子能跳回父亲。
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
// ─────────────────────────────────────────── 回溯补丁幂等（tools/backfill-lineage）

test("回溯补丁幂等：同一记录重复补丁不双登记（重跑=恒等）", async () => {
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
  // 补丁重跑：对「已补过的宿主」再喂同一批候选——条目数与内容逐字段恒等。
  const twice = mergeLineageIntoHost(once, lineageCandidatesFromEntry(legacy));
  assert.deepEqual(twice, once);
});
