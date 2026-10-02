import test from "node:test";
import assert from "node:assert/strict";

import {
  HISTORY_MERGE_TOLERANCE_MS,
  QUOTA_PER_COIN,
  attachBillingCosts,
  buildHistoryFacets,
  buildHistoryStats,
  coinsFromQuota,
  decodeHistoryCursor,
  encodeHistoryCursor,
  filterHistoryEntries,
  formatCoins,
  formatRelativeTime,
  groupHistoryByDay,
  inferEntryKind,
  mergeHistoryEntries,
  normalizeBillingLogEntry,
  normalizeHistoryEntry,
  paginateHistoryEntries,
  sanitizeBlobSegment,
  sortHistoryEntries,
  type HistoryEntry,
} from "./history-types.ts";

function entry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "generatedAt">): HistoryEntry {
  return {
    prompt: "",
    results: [],
    source: "server",
    ...overrides,
  };
}

// ─────────────────────────────────────────── 配额换算

test("coinsFromQuota 把配额单位换算成张数，非法输入归零", () => {
  assert.equal(coinsFromQuota(QUOTA_PER_COIN * 3), 3);
  assert.equal(coinsFromQuota(QUOTA_PER_COIN / 2), 0.5);
  assert.equal(coinsFromQuota(0), 0);
  assert.equal(coinsFromQuota(-100), 0);
  assert.equal(coinsFromQuota(undefined), 0);
  assert.equal(coinsFromQuota(Number.NaN), 0);
});

test("formatCoins 对不足一张的消耗保留有效小数，整数不带小数点", () => {
  assert.equal(formatCoins(QUOTA_PER_COIN * 2), "2");
  assert.equal(formatCoins(QUOTA_PER_COIN / 2), "0.5");
  assert.equal(formatCoins(0), "0");
  assert.equal(formatCoins(QUOTA_PER_COIN * 1.5), "1.5");
});

// ─────────────────────────────────────────── Blob 路径清洗

test("sanitizeBlobSegment 挡住路径穿越与分隔符", () => {
  assert.equal(sanitizeBlobSegment("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeBlobSegment("42-1700000000000"), "42-1700000000000");
  assert.equal(sanitizeBlobSegment("a/b\\c"), "a-b-c");
  assert.equal(sanitizeBlobSegment(""), "item");
  assert.equal(sanitizeBlobSegment("..."), "item");
  assert.equal(sanitizeBlobSegment("....."), "item");
  // 不能以点或横杠开头结尾，否则可能拼出 `history/1/..-x.png`
  assert.ok(!sanitizeBlobSegment("..danger..").startsWith("."));
  assert.ok(!sanitizeBlobSegment("..danger..").endsWith("."));
  assert.ok(sanitizeBlobSegment("x".repeat(500)).length <= 80);
});

// ─────────────────────────────────────────── 规范化

test("normalizeHistoryEntry 丢掉缺少 id 或时间戳的记录", () => {
  assert.equal(normalizeHistoryEntry(null, "server"), null);
  assert.equal(normalizeHistoryEntry({ generatedAt: 1 }, "server"), null);
  assert.equal(normalizeHistoryEntry({ id: "a" }, "server"), null);
  assert.equal(normalizeHistoryEntry({ id: "a", generatedAt: 0 }, "server"), null);
  assert.equal(normalizeHistoryEntry({ id: "a", generatedAt: -5 }, "server"), null);
});

test("normalizeHistoryEntry 过滤掉无效的结果项并截断超量结果", () => {
  const normalized = normalizeHistoryEntry(
    {
      id: "a",
      generatedAt: 1_700_000_000_000,
      results: [
        { provider: "image_tinchak", modelId: "gpt-image-2", imageUrl: "https://x/1.png" },
        { provider: "image_tinchak" }, // 缺 modelId，应被丢弃
        null,
        "nonsense",
      ],
    },
    "server",
  );
  assert.ok(normalized);
  assert.equal(normalized.results.length, 1);
  assert.equal(normalized.results[0].modelId, "gpt-image-2");
  assert.equal(normalized.results[0].image, null);
  // modelId 缺省时从结果里推断
  assert.equal(normalized.modelId, "gpt-image-2");
});

test("normalizeBillingLogEntry 读上游真实字段名并把秒换算成毫秒", () => {
  // 上游返回的是 model_name / quota / created_at（秒），不是 model / prompt / image
  const normalized = normalizeBillingLogEntry({
    id: 3,
    created_at: 1_700_000_000,
    model_name: "gpt-image-2",
    quota: QUOTA_PER_COIN,
    content: "一只猫",
  });
  assert.ok(normalized);
  assert.equal(normalized.generatedAt, 1_700_000_000_000);
  assert.equal(normalized.modelId, "gpt-image-2");
  assert.equal(normalized.quota, QUOTA_PER_COIN);
  assert.equal(normalized.prompt, "一只猫");
  assert.equal(normalized.source, "billing");
  assert.equal(normalized.results.length, 0);
});

test("normalizeBillingLogEntry 的 id 跨页稳定，不依赖上游的每页序号", () => {
  // 上游把 id 重写成每页序号，第 1 页和第 2 页都会出现 id=1
  const first = normalizeBillingLogEntry({ id: 1, created_at: 1_700_000_000, model_name: "m" });
  const second = normalizeBillingLogEntry({ id: 1, created_at: 1_700_000_900, model_name: "m" });
  assert.ok(first && second);
  assert.notEqual(first.id, second.id);
});

// ─────────────────────────────────────────── 归并

test("mergeHistoryEntries 按 id 精确去重，保留信息更全的源", () => {
  const rich = entry({
    id: "same",
    generatedAt: 1_000,
    prompt: "猫",
    source: "server",
    results: [{ provider: "image_tinchak", modelId: "m", image: null, imageUrl: "https://x/1.png" }],
  });
  const poor = entry({ id: "same", generatedAt: 1_000, prompt: "猫", source: "local", results: [] });

  // 顺序不应影响结果
  for (const merged of [mergeHistoryEntries([rich], [poor]), mergeHistoryEntries([poor], [rich])]) {
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, "server");
    assert.equal(merged[0].results.length, 1);
  }
});

test("mergeHistoryEntries 把本地与服务端的同一次生成合成一条", () => {
  // 这是旧实现最大的数据缺陷：本地 id 是 `${userId}-${客户端 Date.now()}`，
  // 服务端 id 是 `${userId}-${服务端 Date.now()}`，两个时刻不同 —— 于是同一次生成渲染两遍。
  const local = entry({
    id: "7-1700000005000",
    generatedAt: 1_700_000_005_000,
    prompt: "一只戴帽子的猫",
    source: "local",
    workflow: { imageSize: "1024x1024" },
  });
  const server = entry({
    id: "7-1700000003000",
    generatedAt: 1_700_000_003_000,
    prompt: "一只戴帽子的猫",
    source: "server",
    results: [{ provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: "https://x/a.png" }],
  });

  // 顺序不应影响结果
  for (const merged of [mergeHistoryEntries([local], [server]), mergeHistoryEntries([server], [local])]) {
    assert.equal(merged.length, 1, "同一次生成应合成一条");
    assert.equal(merged[0].source, "server", "服务端记录字段最全，应当主导");
    assert.equal(merged[0].results.length, 1, "图应当保留");
    assert.deepEqual(merged[0].workflow, { imageSize: "1024x1024" }, "本地的工作流参数应当带过来");
    assert.equal(merged[0].generatedAt, 1_700_000_003_000, "应当取更早的那个时间戳");
  }
});

test("mergeHistoryEntries 不会把超出时间容差的同提示词记录并到一起", () => {
  const a = entry({ id: "a", generatedAt: 1_000_000, prompt: "猫", modelId: "m", source: "local" });
  const b = entry({
    id: "b",
    generatedAt: 1_000_000 + HISTORY_MERGE_TOLERANCE_MS + 1,
    prompt: "猫",
    modelId: "m",
    source: "server",
  });
  assert.equal(mergeHistoryEntries([a, b]).length, 2);
});

test("mergeHistoryEntries 不归并同一个源的两条记录", () => {
  // 同一个源不会给同一次生成写两条；提示词相同只说明用户连着生成了两次
  const a = entry({ id: "a", generatedAt: 1_000, prompt: "猫", modelId: "m", source: "local" });
  const b = entry({ id: "b", generatedAt: 2_000, prompt: "猫", modelId: "m", source: "local" });
  assert.equal(mergeHistoryEntries([a, b]).length, 2);
});

test("mergeHistoryEntries 不归并没有提示词的记录", () => {
  const a = entry({ id: "a", generatedAt: 1_000, source: "local" });
  const b = entry({ id: "b", generatedAt: 1_100, source: "server" });
  assert.equal(mergeHistoryEntries([a, b]).length, 2);
});

test("mergeHistoryEntries 不归并模型不同的记录", () => {
  const a = entry({ id: "a", generatedAt: 1_000, prompt: "猫", modelId: "gpt-image-2", source: "local" });
  const b = entry({ id: "b", generatedAt: 1_100, prompt: "猫", modelId: "nano-banana-pro", source: "server" });
  assert.equal(mergeHistoryEntries([a, b]).length, 2);
});

// ─────────────────────────────────────────── 计费成本附加

test("attachBillingCosts 在候选唯一时附加真实消耗", () => {
  const entries = [entry({ id: "g1", generatedAt: 1_700_000_003_000, prompt: "猫", modelId: "gpt-image-2" })];
  const logs = [
    entry({
      id: "billing-1",
      generatedAt: 1_700_000_003_500,
      source: "billing",
      modelId: "gpt-image-2",
      quota: QUOTA_PER_COIN * 2,
    }),
  ];
  const attached = attachBillingCosts(entries, logs);
  assert.equal(attached[0].quota, QUOTA_PER_COIN * 2);
});

test("attachBillingCosts 在候选有歧义时不猜数字", () => {
  // 同一分钟内用同一模型生成了两次，日志无法可靠对应到具体某一条
  const entries = [entry({ id: "g1", generatedAt: 1_700_000_003_000, modelId: "gpt-image-2" })];
  const logs = [
    entry({ id: "b1", generatedAt: 1_700_000_003_100, source: "billing", modelId: "gpt-image-2", quota: 500 }),
    entry({ id: "b2", generatedAt: 1_700_000_003_200, source: "billing", modelId: "gpt-image-2", quota: 900 }),
  ];
  assert.equal(attachBillingCosts(entries, logs)[0].quota, undefined);
});

test("attachBillingCosts 不会把同一条日志重复算给两条记录", () => {
  const entries = [
    entry({ id: "g1", generatedAt: 1_000_000, modelId: "m" }),
    entry({ id: "g2", generatedAt: 1_000_100, modelId: "m" }),
  ];
  const logs = [entry({ id: "b1", generatedAt: 1_000_050, source: "billing", modelId: "m", quota: 700 })];
  const attached = attachBillingCosts(entries, logs);
  const withQuota = attached.filter((e) => e.quota !== undefined);
  assert.equal(withQuota.length, 1, "一条日志只能认领一次");
});

test("attachBillingCosts 不覆盖已有的消耗，也不动模型不同或超时的记录", () => {
  const entries = [
    entry({ id: "has", generatedAt: 1_000, modelId: "m", quota: 42 }),
    entry({ id: "far", generatedAt: 9_000_000, modelId: "m" }),
    entry({ id: "other", generatedAt: 1_000, modelId: "n" }),
  ];
  const logs = [entry({ id: "b", generatedAt: 1_000, source: "billing", modelId: "m", quota: 999 })];
  const attached = attachBillingCosts(entries, logs);
  assert.equal(attached[0].quota, 42);
  assert.equal(attached[1].quota, undefined);
  assert.equal(attached[2].quota, undefined);
});

test("mergeHistoryEntries 返回时间倒序", () => {
  const merged = mergeHistoryEntries([
    entry({ id: "old", generatedAt: 1_000, prompt: "a" }),
    entry({ id: "new", generatedAt: 9_000, prompt: "b" }),
  ]);
  assert.deepEqual(merged.map((item) => item.id), ["new", "old"]);
});

test("mergeHistoryEntries 的收藏状态取并集", () => {
  const merged = mergeHistoryEntries(
    [entry({ id: "x", generatedAt: 1_000, prompt: "p", modelId: "m", source: "local", starred: true })],
    [entry({ id: "x", generatedAt: 1_000, prompt: "p", modelId: "m", source: "server" })],
  );
  assert.equal(merged[0].starred, true);
});

// ─────────────────────────────────────────── 筛选

test("filterHistoryEntries 的关键词同时匹配提示词与模型名", () => {
  const entries = [
    entry({ id: "a", generatedAt: 3, prompt: "一只猫", modelId: "gpt-image-2" }),
    entry({ id: "b", generatedAt: 2, prompt: "一只狗", modelId: "nano-banana-pro" }),
  ];
  assert.deepEqual(filterHistoryEntries(entries, { keyword: "猫" }).map((e) => e.id), ["a"]);
  assert.deepEqual(filterHistoryEntries(entries, { keyword: "banana" }).map((e) => e.id), ["b"]);
  assert.equal(filterHistoryEntries(entries, { keyword: "不存在" }).length, 0);
});

test("filterHistoryEntries 在提示词为空时不会抛错", () => {
  // 旧实现直接调 entry.prompt.includes(kw)，而计费日志的 prompt 恒为 undefined，一搜就崩
  const entries = [entry({ id: "a", generatedAt: 1, source: "billing" })];
  assert.doesNotThrow(() => filterHistoryEntries(entries, { keyword: "猫" }));
  assert.equal(filterHistoryEntries(entries, { keyword: "猫" }).length, 0);
});

test("filterHistoryEntries 支持收藏、带图、时间区间与尺寸筛选", () => {
  const entries = [
    entry({
      id: "starred",
      generatedAt: 5_000,
      starred: true,
      results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/1.png" }],
      workflow: { imageSize: "1024x1024" },
    }),
    entry({ id: "plain", generatedAt: 1_000 }),
  ];
  assert.deepEqual(filterHistoryEntries(entries, { starredOnly: true }).map((e) => e.id), ["starred"]);
  assert.deepEqual(filterHistoryEntries(entries, { withImageOnly: true }).map((e) => e.id), ["starred"]);
  assert.deepEqual(filterHistoryEntries(entries, { imageSize: "1024x1024" }).map((e) => e.id), ["starred"]);
  assert.deepEqual(filterHistoryEntries(entries, { since: 2_000 }).map((e) => e.id), ["starred"]);
  assert.deepEqual(filterHistoryEntries(entries, { until: 2_000 }).map((e) => e.id), ["plain"]);
});

test("sortHistoryEntries 不改动入参数组", () => {
  const entries = [entry({ id: "a", generatedAt: 1 }), entry({ id: "b", generatedAt: 2 })];
  const sorted = sortHistoryEntries(entries, "newest");
  assert.deepEqual(entries.map((e) => e.id), ["a", "b"]);
  assert.deepEqual(sorted.map((e) => e.id), ["b", "a"]);
});

// ─────────────────────────────────────────── 分面与统计

test("buildHistoryFacets 按出现次数排序模型分面", () => {
  const facets = buildHistoryFacets([
    entry({ id: "1", generatedAt: 3, modelId: "a" }),
    entry({ id: "2", generatedAt: 2, modelId: "b" }),
    entry({ id: "3", generatedAt: 1, modelId: "b" }),
  ]);
  assert.deepEqual(facets.models.map((m) => m.value), ["b", "a"]);
  assert.equal(facets.models[0].count, 2);
  assert.equal(facets.total, 3);
});

test("buildHistoryFacets 的模型标签去掉路径前缀", () => {
  const facets = buildHistoryFacets([entry({ id: "1", generatedAt: 1, modelId: "openai/gpt-image-2" })]);
  assert.equal(facets.models[0].label, "gpt-image-2");
});

test("buildHistoryStats 汇总出图张数与真实消耗", () => {
  const stats = buildHistoryStats([
    entry({
      id: "1",
      generatedAt: 5_000,
      quota: QUOTA_PER_COIN,
      results: [
        { provider: "p", modelId: "m", image: null, imageUrl: "https://x/1.png" },
        { provider: "p", modelId: "m", image: null, imageUrl: null },
      ],
    }),
    entry({ id: "2", generatedAt: 1_000, quota: QUOTA_PER_COIN * 2, starred: true }),
  ]);
  assert.equal(stats.entries, 2);
  assert.equal(stats.images, 1, "没有图的结果项不计入张数");
  assert.equal(stats.quota, QUOTA_PER_COIN * 3);
  assert.equal(stats.starred, 1);
  assert.equal(stats.firstAt, 1_000);
  assert.equal(stats.lastAt, 5_000);
});

test("buildHistoryStats 对空数组返回空区间", () => {
  const stats = buildHistoryStats([]);
  assert.equal(stats.entries, 0);
  assert.equal(stats.firstAt, null);
  assert.equal(stats.lastAt, null);
});

// ─────────────────────────────────────────── 分组

test("groupHistoryByDay 按本地自然日边界分组，不是按距今 24 小时", () => {
  // 固定一个「今天 00:30」的时刻：距今 1 小时的记录属于昨天，而不是今天
  const now = new Date(2026, 6, 26, 0, 30, 0).getTime();
  const oneHourAgo = now - 60 * 60 * 1000;

  const groups = groupHistoryByDay([entry({ id: "a", generatedAt: oneHourAgo })], now);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].bucket, "yesterday");
  assert.equal(groups[0].label, "昨天");
});

test("groupHistoryByDay 按今天/昨天/本周/更早的固定顺序输出，且跳过空组", () => {
  const now = new Date(2026, 6, 26, 12, 0, 0).getTime();
  const day = 24 * 60 * 60 * 1000;
  const groups = groupHistoryByDay(
    [
      entry({ id: "today", generatedAt: now - 60_000 }),
      entry({ id: "earlier", generatedAt: now - 40 * day }),
      entry({ id: "week", generatedAt: now - 3 * day }),
    ],
    now,
  );
  assert.deepEqual(groups.map((g) => g.bucket), ["today", "week", "earlier"]);
});

// ─────────────────────────────────────────── 游标分页

test("游标编解码可往返", () => {
  const target = entry({ id: "abc:def", generatedAt: 1_700_000_000_000 });
  const decoded = decodeHistoryCursor(encodeHistoryCursor(target));
  assert.deepEqual(decoded, { generatedAt: 1_700_000_000_000, id: "abc:def" });
});

test("decodeHistoryCursor 对垃圾输入返回 null", () => {
  assert.equal(decodeHistoryCursor(null), null);
  assert.equal(decodeHistoryCursor(""), null);
  assert.equal(decodeHistoryCursor("nonsense"), null);
  assert.equal(decodeHistoryCursor(":abc"), null);
  assert.equal(decodeHistoryCursor("abc:"), null);
});

test("paginateHistoryEntries 连续翻页既不重复也不遗漏", () => {
  const entries = Array.from({ length: 25 }, (_, i) =>
    entry({ id: `e${i}`, generatedAt: 1_000_000 - i * 1_000 }),
  );

  const seen: string[] = [];
  let cursor: string | null = null;
  let guard = 0;
  do {
    const page: ReturnType<typeof paginateHistoryEntries> = paginateHistoryEntries(entries, cursor, 10);
    seen.push(...page.entries.map((e) => e.id));
    cursor = page.cursor;
    guard += 1;
  } while (cursor && guard < 10);

  assert.equal(seen.length, 25, "应当刚好遍历全部记录");
  assert.equal(new Set(seen).size, 25, "不应出现重复");
  assert.deepEqual(seen, entries.map((e) => e.id), "顺序应当保持时间倒序");
});

test("paginateHistoryEntries 在同一毫秒的多条记录处也不会漏", () => {
  // 只用时间戳当游标会在这里丢数据
  const entries = [
    entry({ id: "a", generatedAt: 5_000 }),
    entry({ id: "b", generatedAt: 5_000 }),
    entry({ id: "c", generatedAt: 5_000 }),
  ];
  const first = paginateHistoryEntries(entries, null, 2);
  assert.equal(first.entries.length, 2);
  const second = paginateHistoryEntries(entries, first.cursor, 2);
  assert.equal(second.entries.length, 1);
  const all = [...first.entries, ...second.entries].map((e) => e.id).sort();
  assert.deepEqual(all, ["a", "b", "c"]);
});

test("paginateHistoryEntries 在游标指向的记录被删除后仍能继续翻页", () => {
  const entries = [
    entry({ id: "a", generatedAt: 3_000 }),
    entry({ id: "c", generatedAt: 1_000 }),
  ];
  // 游标指向一条已被删掉的记录（generatedAt 2000）
  const page = paginateHistoryEntries(entries, "2000:deleted", 10);
  assert.deepEqual(page.entries.map((e) => e.id), ["c"]);
});

test("paginateHistoryEntries 到末页时游标为 null", () => {
  const entries = [entry({ id: "a", generatedAt: 1_000 })];
  const page = paginateHistoryEntries(entries, null, 10);
  assert.equal(page.cursor, null);
  assert.equal(page.total, 1);
});

test("paginateHistoryEntries 把页大小限制在合理区间", () => {
  const entries = Array.from({ length: 200 }, (_, i) => entry({ id: `e${i}`, generatedAt: 200_000 - i }));
  assert.equal(paginateHistoryEntries(entries, null, 0).entries.length, 24, "0 应回落到默认页大小");
  assert.equal(paginateHistoryEntries(entries, null, -5).entries.length, 1, "负数应被夹到 1");
  assert.equal(paginateHistoryEntries(entries, null, 9_999).entries.length, 100, "超大值应被夹到 100");
});

// ─────────────────────────────────────────── 时间展示

test("formatRelativeTime 覆盖各个量级且不会给出未来时间", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now, now), "刚刚");
  assert.equal(formatRelativeTime(now + 10_000, now), "刚刚");
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5 分钟前");
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), "3 小时前");
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), "2 天前");
  assert.equal(formatRelativeTime(now - 60 * 86_400_000, now), "2 个月前");
  assert.equal(formatRelativeTime(now - 400 * 86_400_000, now), "1 年前");
});

// ─────────────────────────────────────────── 记录类型（entryKind）

test("inferEntryKind 三条分支：显式 entryKind / source=workflow / DAG / results 媒体类型", () => {
  // ① 显式 entryKind 永远最准（即使 source 是 local）
  assert.equal(inferEntryKind(entry({ id: "a", generatedAt: 1, entryKind: "workflow" })), "workflow");
  assert.equal(inferEntryKind(entry({ id: "a", generatedAt: 1, source: "workflow", entryKind: "video" })), "video");

  // ② source === "workflow"
  assert.equal(inferEntryKind(entry({ id: "b", generatedAt: 1, source: "workflow" })), "workflow");

  // ③ workflow 带 dagNodes（老记录，source 被归并成 server 面）
  assert.equal(
    inferEntryKind(entry({ id: "c", generatedAt: 1, workflow: { dagNodes: [{ id: "n1" }] } })),
    "workflow",
  );
  // 空 dagNodes 不算工作流（推送失败留下的空数组）
  assert.equal(inferEntryKind(entry({ id: "c2", generatedAt: 1, workflow: { dagNodes: [] } })), "image");

  // ④ results 媒体类型 → video
  assert.equal(
    inferEntryKind(
      entry({
        id: "d",
        generatedAt: 1,
        results: [{ provider: "p", modelId: "m", image: null, imageUrl: null, mediaType: "video" }],
      }),
    ),
    "video",
  );
  assert.equal(
    inferEntryKind(
      entry({
        id: "d2",
        generatedAt: 1,
        results: [{ provider: "p", modelId: "m", image: null, imageUrl: null, videoUrl: "https://x/a.mp4" }],
      }),
    ),
    "video",
  );

  // ⑤ 兜底 image（含无 results 的空记录，绝不抛）
  assert.equal(inferEntryKind(entry({ id: "e", generatedAt: 1 })), "image");
  assert.equal(
    inferEntryKind(
      entry({
        id: "f",
        generatedAt: 1,
        results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/a.png" }],
      }),
    ),
    "image",
  );
});

test("matchesHistoryQuery 按 entryKind 过滤（且与 withImageOnly 正交）", () => {
  const workflowEntry = entry({ id: "w", generatedAt: 3, source: "workflow", prompt: "工作流 x" });
  const imageEntry = entry({
    id: "i",
    generatedAt: 2,
    results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/a.png" }],
  });
  const videoEntry = entry({
    id: "v",
    generatedAt: 1,
    results: [{ provider: "p", modelId: "m", image: null, imageUrl: null, mediaType: "video" }],
  });

  assert.deepEqual(filterHistoryEntries([workflowEntry, imageEntry, videoEntry], { entryKind: "workflow" }).map((e) => e.id), ["w"]);
  assert.deepEqual(filterHistoryEntries([workflowEntry, imageEntry, videoEntry], { entryKind: "video" }).map((e) => e.id), ["v"]);
  assert.deepEqual(filterHistoryEntries([workflowEntry, imageEntry, videoEntry], { entryKind: "image" }).map((e) => e.id), ["i"]);
  // 缺 entryKind 时不限类型
  assert.equal(filterHistoryEntries([workflowEntry, imageEntry, videoEntry], {}).length, 3);
  // hasImage 与 entryKind 是两条独立条件：工作流记录没有图，withImageOnly 会把它筛掉
  assert.deepEqual(
    filterHistoryEntries([workflowEntry, imageEntry], { entryKind: "workflow", withImageOnly: true }).map((e) => e.id),
    [],
  );
});

test("normalizeHistoryEntry 白名单收 entryKind（非法值丢弃），source=workflow 自动补 workflow", () => {
  const withKind = normalizeHistoryEntry({ id: "a", generatedAt: 1, entryKind: "video" }, "server");
  assert.equal(withKind?.entryKind, "video");

  const bogus = normalizeHistoryEntry({ id: "a", generatedAt: 1, entryKind: "hologram" }, "server");
  assert.equal(bogus?.entryKind, undefined);
  assert.ok(!("entryKind" in (bogus as object)));

  // 推送端点写的记录走 server 面：source 由调用方给，entryKind 显式给 workflow
  const pushed = normalizeHistoryEntry(
    { id: "workflow-wf1", generatedAt: 1, entryKind: "workflow", workflow: { dagNodes: [{ id: "n1" }] } },
    "server",
  );
  assert.equal(pushed?.entryKind, "workflow");
  // workflow 字段维持 passthrough：DAG 四欄原样保留
  assert.deepEqual((pushed?.workflow as { dagNodes: unknown[] }).dagNodes, [{ id: "n1" }]);

  // source=workflow 且没给 entryKind → 自动补 workflow（旧记录/漏欄的兜底）
  const fromSource = normalizeHistoryEntry({ id: "b", generatedAt: 1 }, "workflow");
  assert.equal(fromSource?.entryKind, "workflow");
});

// ─────────────────────────────────────────── 音频记录（entryKind = audio）

test("normalizeHistoryEntry 收 entryKind:audio 与 audioUrl/mediaType:audio", () => {
  const normalized = normalizeHistoryEntry(
    {
      id: "music-1",
      generatedAt: 1_700_000_000_000,
      prompt: "帮我写首歌",
      entryKind: "audio",
      results: [
        {
          provider: "flowmusic",
          modelId: "flowmusic-v1",
          audioUrl: "https://x/song.mp3",
          mediaType: "audio",
        },
      ],
    },
    "server",
  );
  assert.ok(normalized);
  assert.equal(normalized.entryKind, "audio");
  assert.equal(normalized.results[0].audioUrl, "https://x/song.mp3");
  assert.equal(normalized.results[0].mediaType, "audio");
  // 真行为断言：读回的 entry 经 inferEntryKind 仍判为 audio
  assert.equal(inferEntryKind(normalized), "audio");
});

test("inferEntryKind 对旧式「只有 audioUrl」的记录也判 audio", () => {
  // 旧记录没有 entryKind、也没有 mediaType，只有产物 URL —— 归并后主记录走 server 面
  const legacy = entry({
    id: "legacy-audio",
    generatedAt: 1,
    results: [{ provider: "flowmusic", modelId: "flowmusic-v1", image: null, imageUrl: null, audioUrl: "https://x/a.mp3" }],
  });
  assert.equal(legacy.entryKind, undefined);
  assert.equal(inferEntryKind(legacy), "audio");

  // 只有 mediaType:"audio"、没有 URL（旧记录/异常中间态）也判 audio
  const byTypeOnly = entry({
    id: "type-only-audio",
    generatedAt: 1,
    results: [{ provider: "flowmusic", modelId: "flowmusic-v1", image: null, imageUrl: null, mediaType: "audio" }],
  });
  assert.equal(inferEntryKind(byTypeOnly), "audio");
});

test("normalizeHistoryEntry 白名单丢弃非法 entryKind（garbage 回落推断）", () => {
  const bogus = normalizeHistoryEntry({ id: "a", generatedAt: 1, entryKind: "garbage" }, "server");
  assert.ok(bogus);
  assert.equal(bogus.entryKind, undefined);
  assert.ok(!("entryKind" in (bogus as object)));
  // 没有合法 entryKind → 回落到 results 推断
  assert.equal(inferEntryKind(bogus), "image");
});

test("inferEntryKind 同时带视频与音频时以视频为主（video 分支优先）", () => {
  const both = entry({
    id: "both",
    generatedAt: 1,
    results: [
      { provider: "p", modelId: "m", image: null, imageUrl: null, videoUrl: "https://x/a.mp4" },
      { provider: "p", modelId: "m", image: null, imageUrl: null, audioUrl: "https://x/a.mp3" },
    ],
  });
  assert.equal(inferEntryKind(both), "video");
});

test("inferEntryKind：单一 result 同时带 imageUrl 与 videoUrl（无 mediaType）仍判 video", () => {
  // 回退钉子：整改前 `result.videoUrl` 即判 video；整改后一度因只取
  // deliverableKindOfResult 的单投影（按宣告序先扫 image）而退为 image。
  // 媒体分支改为逐 result、逐注册表字段收集所有命中后，videoUrl 重新可见。
  const posterPlusVideoNoType = entry({
    id: "single-dual-url",
    generatedAt: 1,
    results: [
      {
        provider: "p",
        modelId: "m",
        image: null,
        imageUrl: "https://x/poster.png",
        videoUrl: "https://x/a.mp4",
        // 刻意不带 mediaType —— 旧 server blob / 客户端历史正是这个形态。
      },
    ],
  });
  assert.equal(posterPlusVideoNoType.results[0].mediaType, undefined);
  assert.equal(inferEntryKind(posterPlusVideoNoType), "video");

  // 真实产物形态（显式 mediaType:video）不得回归。
  const posterPlusVideo = entry({
    id: "poster-video",
    generatedAt: 1,
    results: [
      {
        provider: "p",
        modelId: "m",
        image: null,
        imageUrl: "https://x/poster.png",
        videoUrl: "https://x/a.mp4",
        mediaType: "video",
      },
    ],
  });
  assert.equal(inferEntryKind(posterPlusVideo), "video");

  // 跨 result：imageUrl 与 videoUrl 落在不同结果，种类取并集后 video 仍胜出。
  const splitAcrossResults = entry({
    id: "split-video",
    generatedAt: 1,
    results: [
      { provider: "p", modelId: "m", image: null, imageUrl: "https://x/poster.png" },
      { provider: "p", modelId: "m", image: null, imageUrl: null, videoUrl: "https://x/a.mp4" },
    ],
  });
  assert.equal(inferEntryKind(splitAcrossResults), "video");
});

test("inferEntryKind：单一 result 同时带 imageUrl 与 audioUrl（无 mediaType）判 audio（audio 胜 image）", () => {
  const posterPlusAudioNoType = entry({
    id: "single-audio-url",
    generatedAt: 1,
    results: [
      {
        provider: "p",
        modelId: "m",
        image: null,
        imageUrl: "https://x/cover.png",
        audioUrl: "https://x/a.mp3",
      },
    ],
  });
  assert.equal(posterPlusAudioNoType.results[0].mediaType, undefined);
  assert.equal(inferEntryKind(posterPlusAudioNoType), "audio");
});

test("inferEntryKind：单产物各形态不回退（只有 audioUrl→audio、只有 imageUrl→image、无媒体→image）", () => {
  const onlyAudio = entry({
    id: "only-audio",
    generatedAt: 1,
    results: [{ provider: "p", modelId: "m", image: null, imageUrl: null, audioUrl: "https://x/a.mp3" }],
  });
  assert.equal(inferEntryKind(onlyAudio), "audio");

  const onlyImage = entry({
    id: "only-image",
    generatedAt: 1,
    results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/a.png" }],
  });
  assert.equal(inferEntryKind(onlyImage), "image");

  const noMedia = entry({
    id: "no-media",
    generatedAt: 1,
    results: [{ provider: "p", modelId: "m", image: null, imageUrl: null }],
  });
  assert.equal(inferEntryKind(noMedia), "image");
  assert.equal(inferEntryKind(entry({ id: "empty", generatedAt: 1 })), "image");
});

test("filterHistoryEntries 支持按 entryKind:audio 过滤，且 audio 计入「有图」", () => {
  const audioEntry = entry({
    id: "audio",
    generatedAt: 1,
    results: [{ provider: "flowmusic", modelId: "flowmusic-v1", image: null, imageUrl: null, audioUrl: "https://x/a.mp3", mediaType: "audio" }],
  });
  const imageEntry = entry({
    id: "image",
    generatedAt: 2,
    results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/a.png" }],
  });
  const billing = entry({ id: "billing", generatedAt: 3, source: "billing" });

  assert.deepEqual(
    filterHistoryEntries([audioEntry, imageEntry, billing], { entryKind: "audio" }).map((e) => e.id),
    ["audio"],
  );
  // 音乐是有产物的记录，与视频同语义地计入 withImageOnly（该筛选的用意是排除无媒体计费日志）
  assert.deepEqual(
    filterHistoryEntries([audioEntry, imageEntry, billing], { withImageOnly: true }).map((e) => e.id),
    ["audio", "image"],
  );
  assert.equal(buildHistoryFacets([audioEntry, imageEntry, billing]).withImageCount, 2);
});

test("normalizeHistoryEntry 现在也显式写入 mediaType:image（新契约）", () => {
  // 舊行为刻意对 image 不写 mediaType（缺省即 image）；改由交付物注册表统一后，
  // image 也显式落 mediaType，与 video/audio 同形。这不是放宽——是契约改变：
  // mediaType 的值域与 deliverable-kind 注册表完全一致。
  const normalized = normalizeHistoryEntry(
    {
      id: "img-1",
      generatedAt: 1_700_000_000_000,
      results: [{ provider: "p", modelId: "m", imageUrl: "https://x/a.png", mediaType: "image" }],
    },
    "server",
  );
  assert.ok(normalized);
  assert.equal(normalized.results[0].mediaType, "image");
  // 非法 mediaType 仍被白名单丢弃。
  const bogus = normalizeHistoryEntry(
    {
      id: "img-2",
      generatedAt: 1,
      results: [{ provider: "p", modelId: "m", imageUrl: "https://x/a.png", mediaType: "garbage" }],
    },
    "server",
  );
  assert.ok(bogus);
  assert.equal(bogus.results[0].mediaType, undefined);
  // 有注册表 mediaType 时，推断仍以产物 URL / 型别为准（image 不因显式型别而误判）。
  assert.equal(inferEntryKind(normalized), "image");
});
