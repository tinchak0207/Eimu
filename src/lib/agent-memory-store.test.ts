// agent-memory-store 行为测试（PRD §9 R6／D6：真行为断言，禁源码字串测试）。
//
// 本机无 blob 凭证（实测 BlobError 即刻抛、0ms），readBlobTextAt/writeBlobText
// 全部静默失败 → 走进程内 Map 兜底路径，正好可做纯内存 E2E。
// 注意 loadCatalog 有进程内快取：每个 test 开头一律 __resetAgentMemoryStoreForTests()。
// 配额日期用 ingest 的 now 注入钉死（2026-09-15），测序自洽、不受跑测日期影响。

import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetAgentMemoryStoreForTests,
  ingestMemoryDocs,
  listMemoryDocs,
  readMemoryIndexMd,
  retractMemoryDocs,
  reviewMemoryDocs,
  saveBatchReport,
  type AgentMemoryDocInput,
} from "./agent-memory-store";

const NOW = new Date("2026-09-15T12:00:00.000Z");

function sharedDoc(overrides: Partial<AgentMemoryDocInput> = {}): AgentMemoryDocInput {
  return {
    scope: "shared",
    domain: "测试领域",
    slug: "basic-note",
    description: "a baseline shared knowledge note",
    type: "domain",
    body: "**Why:** 测试\n**How to apply:** 测试",
    evidence: "tool result line one",
    evidenceKind: "tool_result",
    selfScore: 5,
    // shared 自 4ea47695 起 fail-closed：无 contributorKey 一律 pending_review。
    // fixture 补上提出者；需要文档立即 active 的用例再显式传 corroborationMin: 1。
    contributorKey: "owner-a-hash",
    ...overrides,
  };
}

/** shared 文档立即 active 所需的最小佐证门槛（生产缺省为 2）。 */
const ACTIVE_SHARED = { corroborationMin: 1 } as const;

function privateDoc(overrides: Partial<AgentMemoryDocInput> = {}): AgentMemoryDocInput {
  return {
    scope: "private",
    ownerKey: "owner-a-hash",
    domain: "账户偏好",
    slug: "pref-cinematic",
    description: "user prefers cinematic lighting",
    type: "user",
    body: "always ask for cinematic look first",
    evidence: "user said so",
    evidenceKind: "user_confirmed",
    selfScore: 4,
    ...overrides,
  };
}

test("G5：同 slug 再入库 → revision+1、id 稳定、清单只剩一条", async () => {
  __resetAgentMemoryStoreForTests();
  const first = await ingestMemoryDocs({ batchId: "b1", docs: [sharedDoc()], now: NOW, ...ACTIVE_SHARED });
  assert.deepEqual(first.rejected, []);
  assert.deepEqual(first.accepted, ["b1-basic-note"]);
  const list1 = await listMemoryDocs({ scope: "shared" });
  assert.equal(list1.length, 1);
  assert.equal(list1[0].revision, 1);
  assert.equal(list1[0].status, "active");

  // 第二笔同 scope+slug（换批次号）→ 走更新分支：id 保留、revision 翻到 2。
  const second = await ingestMemoryDocs({
    batchId: "b2",
    docs: [sharedDoc({ body: "**Why:** 第二版\n**How to apply:** 更新" })],
    now: NOW,
    ...ACTIVE_SHARED,
  });
  assert.deepEqual(second.accepted, ["b1-basic-note"]);
  assert.deepEqual(second.rejected, []);
  const list2 = await listMemoryDocs({ scope: "shared" });
  assert.equal(list2.length, 1);
  assert.equal(list2[0].revision, 2);
  assert.equal(list2[0].id, "b1-basic-note");
  assert.equal(list2[0].batchId, "b1"); // 原批次锚定不变
  assert.match(list2[0].body, /第二版/);
});

test("G5：description Jaccard>0.8 → duplicate 拒绝（不同 slug 也拒）", async () => {
  __resetAgentMemoryStoreForTests();
  const result = await ingestMemoryDocs({
    batchId: "b3",
    docs: [
      sharedDoc({ slug: "alpha", description: "one two three four five six seven eight nine ten" }),
      sharedDoc({ slug: "beta", description: "one two three four five six seven eight nine jack" }),
      sharedDoc({ slug: "gamma", description: "totally different insight about lighting setup" }),
    ],
    now: NOW,
    ...ACTIVE_SHARED,
  });
  assert.deepEqual(result.accepted, ["b3-alpha", "b3-gamma"]);
  assert.deepEqual(result.rejected, [{ slug: "beta", reason: "duplicate" }]);
});

test("G7：单 domain ≤8/日，第 9 条 quota_domain", async () => {
  __resetAgentMemoryStoreForTests();
  const docs = Array.from({ length: 9 }, (_, i) =>
    sharedDoc({
      domain: "配额域",
      slug: `note-${i + 1}`,
      description: `domain fact number ${i + 1} unique${i + 1}`,
    }),
  );
  const result = await ingestMemoryDocs({ batchId: "b4", docs, now: NOW });
  assert.equal(result.accepted.length, 8);
  assert.deepEqual(result.rejected, [{ slug: "note-9", reason: "quota_domain" }]);
  assert.equal(result.stats.accepted, 8);
});

test("G7：单 ownerKey private ≤10/日，超额 quota_scope", async () => {
  __resetAgentMemoryStoreForTests();
  const docs = Array.from({ length: 12 }, (_, i) =>
    privateDoc({
      domain: `偏好域${i + 1}`,
      slug: `pref-${i + 1}`,
      description: `account preference item ${i + 1} variant${i + 1}`,
    }),
  );
  const result = await ingestMemoryDocs({ batchId: "b5", docs, now: NOW });
  assert.equal(result.accepted.length, 10);
  assert.equal(result.rejected.length, 2);
  assert.deepEqual(result.rejected.map((r) => r.reason), ["quota_scope", "quota_scope"]);
  const listed = await listMemoryDocs({ scope: "private", ownerKey: "owner-a-hash" });
  assert.equal(listed.length, 10);
});

test("G7：单批 shared ≤20，第 21 条 quota_scope（Map 兜底很快，大批照测）", async () => {
  __resetAgentMemoryStoreForTests();
  const docs = Array.from({ length: 21 }, (_, i) =>
    sharedDoc({
      domain: `共享域${i + 1}`,
      slug: `bulk-${i + 1}`,
      description: `shared knowledge item ${i + 1} marker${i + 1}`,
    }),
  );
  const result = await ingestMemoryDocs({ batchId: "b6", docs, now: NOW });
  assert.equal(result.accepted.length, 20);
  assert.deepEqual(result.rejected, [{ slug: "bulk-21", reason: "quota_scope" }]);
});

test("空 batchId → 全拒 structure、零写入", async () => {
  __resetAgentMemoryStoreForTests();
  const result = await ingestMemoryDocs({
    batchId: "   ",
    docs: [sharedDoc({ slug: "s1" }), privateDoc({ slug: "s2" })],
    now: NOW,
  });
  assert.deepEqual(result.accepted, []);
  assert.equal(result.rejected.length, 2);
  assert.deepEqual(result.rejected.map((r) => r.reason), ["structure", "structure"]);
  assert.deepEqual(result.stats, { received: 2, accepted: 0, index_lines: 0, seed_accepted: 0 });
  assert.equal((await listMemoryDocs({ scope: "shared" })).length, 0);
});

test("结构防线：坏 slug／超长 description → structure", async () => {
  __resetAgentMemoryStoreForTests();
  const result = await ingestMemoryDocs({
    batchId: "b7",
    docs: [
      sharedDoc({ slug: "Bad Slug!" }),
      sharedDoc({ slug: "too-long", description: "x".repeat(121) }),
      privateDoc({ slug: "no-owner", ownerKey: undefined }), // private 缺 ownerKey
    ],
    now: NOW,
  });
  assert.equal(result.accepted.length, 0);
  assert.deepEqual(result.rejected.map((r) => r.reason), ["structure", "structure", "structure"]);
});

test("retract（按 doc_ids）：list 不含、INDEX 行移除、不删档（再入库 id 锚定原目录条目）", async () => {
  __resetAgentMemoryStoreForTests();
  const ingested = await ingestMemoryDocs({
    batchId: "b8",
    docs: [sharedDoc({ slug: "keep" }), sharedDoc({ slug: "drop", description: "another distinct insight" })],
    now: NOW,
    ...ACTIVE_SHARED,
  });
  assert.deepEqual(ingested.accepted, ["b8-keep", "b8-drop"]);
  const indexBefore = await readMemoryIndexMd("shared");
  assert.match(indexBefore, /drop/);

  const retracted = await retractMemoryDocs({ docIds: ["b8-drop"] });
  assert.deepEqual(retracted.retracted, ["b8-drop"]);

  const listed = await listMemoryDocs({ scope: "shared" });
  assert.deepEqual(listed.map((doc) => doc.slug), ["keep"]);
  const indexAfter = await readMemoryIndexMd("shared");
  assert.doesNotMatch(indexAfter, /drop/);
  assert.match(indexAfter, /- \[测试领域\] keep — .*（v1）/);
});

test("retract（按 batch_id）：整批移除；空条件回空", async () => {
  __resetAgentMemoryStoreForTests();
  const ingested = await ingestMemoryDocs({
    batchId: "b9",
    docs: [privateDoc({ slug: "p1" }), privateDoc({ slug: "p2", description: "second user preference line" })],
    now: NOW,
  });
  assert.equal(ingested.accepted.length, 2);
  const retracted = await retractMemoryDocs({ batchId: "b9" });
  assert.deepEqual(retracted.retracted.sort(), ["b9-p1", "b9-p2"]);
  assert.equal((await listMemoryDocs({ scope: "private", ownerKey: "owner-a-hash" })).length, 0);
  assert.equal(await readMemoryIndexMd("private", "owner-a-hash"), "");
  // 空条件（无 ids 无 batch）：不炸、不回撤回任何笔。
  assert.deepEqual(await retractMemoryDocs({}), { retracted: [] });
});

test("review：pending_review 翻转仅 shared（PRD §5.6 private 不自动翻）、清单与 INDEX 同步消失", async () => {
  __resetAgentMemoryStoreForTests();
  const ingested = await ingestMemoryDocs({
    batchId: "rv1",
    docs: [
      sharedDoc({ slug: "s-note", description: "shared insight for review flip" }),
      privateDoc({ slug: "p-note", description: "private insight must stay active" }),
    ],
    now: NOW,
    ...ACTIVE_SHARED,
  });
  assert.deepEqual(ingested.accepted, ["rv1-s-note", "rv1-p-note"]);

  const flipped = await reviewMemoryDocs({ batchId: "rv1", action: "pending_review" });
  assert.deepEqual(flipped, { reviewed: ["rv1-s-note"], action: "pending_review", blocked: [] });
  // 翻转后：shared 清单不含、INDEX 行消失；private 不受影响。
  assert.deepEqual(await listMemoryDocs({ scope: "shared" }), []);
  assert.equal(await readMemoryIndexMd("shared"), "");
  const privates = await listMemoryDocs({ scope: "private", ownerKey: "owner-a-hash" });
  assert.deepEqual(privates.map((doc) => doc.slug), ["p-note"]);
  assert.match(await readMemoryIndexMd("private", "owner-a-hash"), /p-note/);
});

test("review：activate 人工放行 → pending_review 翻回 active，INDEX 行恢复", async () => {
  __resetAgentMemoryStoreForTests();
  await ingestMemoryDocs({
    batchId: "rv2",
    docs: [sharedDoc({ slug: "flip-me", description: "doc to flip back on activation" })],
    now: NOW,
    ...ACTIVE_SHARED,
  });
  const pending = await reviewMemoryDocs({ docIds: ["rv2-flip-me"], action: "pending_review" });
  assert.deepEqual(pending.reviewed, ["rv2-flip-me"]);
  assert.deepEqual(await listMemoryDocs({ scope: "shared" }), []);

  const activated = await reviewMemoryDocs({ batchId: "rv2", action: "activate" });
  assert.deepEqual(activated, { reviewed: ["rv2-flip-me"], action: "activate", blocked: [] });
  const listed = await listMemoryDocs({ scope: "shared" });
  assert.deepEqual(listed.map((doc) => doc.slug), ["flip-me"]);
  assert.equal(listed[0].status, "active");
  assert.match(
    await readMemoryIndexMd("shared"),
    /- \[测试领域\] flip-me — doc to flip back on activation （v1）/,
  );
});

test("review：显式 scope=private 才可翻私有；retracted 拒绝翻转；空条件回空", async () => {
  __resetAgentMemoryStoreForTests();
  await ingestMemoryDocs({
    batchId: "rv3",
    docs: [
      privateDoc({ slug: "priv", description: "private doc flipped with explicit scope" }),
      sharedDoc({ slug: "gone", description: "shared doc retracted then review-proof" }),
    ],
    now: NOW,
    ...ACTIVE_SHARED,
  });
  const privFlip = await reviewMemoryDocs({
    batchId: "rv3",
    action: "pending_review",
    scope: "private",
  });
  assert.deepEqual(privFlip.reviewed, ["rv3-priv"]);

  // retracted 为留证终态：两个方向都不翻。
  await retractMemoryDocs({ docIds: ["rv3-gone"] });
  // 默认 pending_review 只查 shared：gone（retracted）不合来源态、priv（已 pending）不合默认过滤。
  const noPending = await reviewMemoryDocs({ batchId: "rv3", action: "pending_review" });
  assert.deepEqual(noPending.reviewed, []);
  const noActivate = await reviewMemoryDocs({ docIds: ["rv3-gone"], action: "activate" });
  assert.deepEqual(noActivate.reviewed, []);
  // 人工放行：显式 ids 把 pending 的 private 翻回 active。
  const releasePriv = await reviewMemoryDocs({ docIds: ["rv3-priv"], action: "activate" });
  assert.deepEqual(releasePriv.reviewed, ["rv3-priv"]);
  assert.deepEqual(
    (await listMemoryDocs({ scope: "private", ownerKey: "owner-a-hash" })).map((doc) => doc.slug),
    ["priv"],
  );
  // 空条件不炸。
  assert.deepEqual(await reviewMemoryDocs({ action: "activate" }), {
    reviewed: [],
    action: "activate",
    blocked: [],
  });
});

test("索引与清单形状：INDEX 行符合契约格式；private 缺 ownerKey 回空", async () => {
  __resetAgentMemoryStoreForTests();
  await ingestMemoryDocs({ batchId: "b10", docs: [sharedDoc()], now: NOW, ...ACTIVE_SHARED });
  const index = await readMemoryIndexMd("shared");
  assert.equal(index, "- [测试领域] basic-note — a baseline shared knowledge note （v1）");
  assert.deepEqual(await listMemoryDocs({ scope: "private" }), []);
});

test("saveBatchReport 不炸（blob 失败静默）", async () => {
  __resetAgentMemoryStoreForTests();
  await assert.doesNotReject(saveBatchReport("b11", { stored: 2, rejected: {} }));
});

test("stats.index_lines 与实际索引行数一致", async () => {
  __resetAgentMemoryStoreForTests();
  const result = await ingestMemoryDocs({
    batchId: "b12",
    docs: [
      sharedDoc({ slug: "x1", description: "first distinct shared line" }),
      sharedDoc({ slug: "x2", description: "second distinct shared line" }),
      privateDoc({ slug: "x3", description: "third distinct private line" }),
    ],
    now: NOW,
    ...ACTIVE_SHARED,
  });
  assert.equal(result.stats.index_lines, 3); // shared 2 行 + private 1 行
  assert.deepEqual(result.stats, {
    received: 3,
    accepted: 3,
    index_lines: 3,
    seed_accepted: 0,
  });
});
