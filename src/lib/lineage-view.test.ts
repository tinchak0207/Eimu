import test from "node:test";
import assert from "node:assert/strict";

import { buildLineagePool, cardToLineageView, entryToLineageView } from "./lineage-view.ts";
import { cardFromHistoryEntry } from "./history-card-anchor.ts";
import { normalizeCharacterCard, type CharacterCard } from "./character-cards.ts";
import { generationJobHistoryEntry } from "./generation-task-history.ts";
import { encryptGenerationPrompt } from "./generation-core/crypto.ts";
import type { GenerationJob } from "./generation-core/types.ts";
import { MAX_LINEAGE_PARENTS, historyEntryHandles } from "./lineage.ts";
import type { LineageLink } from "./lineage.ts";
import type { HistoryEntry } from "./history-types.ts";

const T0 = "2026-09-22T00:00:00.000Z";
// job 投影要解密 prompt（generationTaskProjection includePrompt:true）：
// 鑰匙是測試一次性合成值，不讀任何真實憑證 env。
process.env.GENERATION_PROMPT_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function entry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, "id">): HistoryEntry {
  return {
    prompt: "",
    generatedAt: 1700000000000,
    results: [],
    source: "server",
    ...overrides,
  };
}

// ─────────────────────────────────────── 掛鉤 b：存為卡片登記 derivation

test("掛鉤 b：cardFromHistoryEntry 把來源歷史記錄登記成卡的 derivation 血統", () => {
  const jobEntry = entry({ id: "e1", taskId: "task-e1", prompt: "来源", results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/1.png" }] });
  const card = cardFromHistoryEntry(jobEntry, "character", "锁一张");
  assert.ok(card);
  assert.equal(card.lineage?.length, 1);
  assert.equal(card.lineage?.[0].kind, "derivation");
  assert.equal(card.lineage?.[0].jobId, "task-e1");

  const syncEntry = entry({ id: "e2", results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/2.png" }] });
  const cardSync = cardFromHistoryEntry(syncEntry, "style", "无任务的来源");
  const handles = historyEntryHandles(syncEntry);
  assert.equal(cardSync?.lineage?.[0].kind, "derivation");
  assert.equal(cardSync?.lineage?.[0].assetId, handles.assetIds[0]);
  assert.equal(cardSync?.lineage?.[0].jobId, undefined);
});

test("卡血統經 normalizeCharacterCard 收口存活且過上限截尾", () => {
  const base: CharacterCard = {
    id: "card-1",
    name: "卡",
    kind: "character",
    prompt: "",
    references: [{ url: "https://x/1.png", role: "character", name: "卡" }],
    createdAt: T0,
    updatedAt: T0,
    lineage: Array.from({ length: 8 }, (_, i) => ({ kind: "derivation", jobId: `t${i}`, at: T0 } as LineageLink)),
    lineageTruncated: true,
  };
  const normalized = normalizeCharacterCard(base);
  assert.ok(normalized);
  assert.equal(normalized.lineage?.length, MAX_LINEAGE_PARENTS);
  assert.equal(normalized.lineageTruncated, true);
  // 沒登記的卡不憑空多出欄位。
  const plain = normalizeCharacterCard({ ...base, lineage: undefined, lineageTruncated: undefined });
  assert.equal(plain?.lineage, undefined);
});

// ─────────────────────────────────────── 掛鉤 c：job 投影讀時透傳

function job(overrides: Partial<GenerationJob>): GenerationJob {
  return {
    id: "job-1",
    tenantId: "web:1",
    apiKeyId: null,
    billingUserId: 1,
    source: "web",
    idempotencyKey: null,
    requestHash: "h",
    kind: "image_generate",
    routingClass: "generic",
    modelId: "gpt-image-2",
    size: null,
    ratio: "1:1",
    resolution: "1k",
    quality: "fast",
    promptCiphertext: encryptGenerationPrompt("p"),
    workflow: {},
    responseFormat: "url",
    callbackUrl: null,
    retryOfTaskId: null,
    primaryResultId: null,
    status: "succeeded",
    requestedCount: 1,
    completedCount: 1,
    attemptCount: 1,
    billingAmount: 0,
    deadlineAt: new Date(),
    availableAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    failureClass: null,
    failureDetail: null,
    result: null,
    createdAt: new Date(T0),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date(T0),
    ...overrides,
  };
}

test("掛鉤 c：job.retryOfTaskId 投影成 rerun 血統；無 taskId 的源走 sourceHistoryId 把手", () => {
  const withRetry = generationJobHistoryEntry(job({ retryOfTaskId: "task-parent" }));
  assert.equal(withRetry.lineage?.length, 1);
  assert.equal(withRetry.lineage?.[0].kind, "rerun");
  assert.equal(withRetry.lineage?.[0].jobId, "task-parent");

  const viaWorkflow = generationJobHistoryEntry(
    job({ workflow: { sourceHistoryId: "82-legacy" } }),
  );
  assert.equal(viaWorkflow.lineage?.[0].kind, "rerun");
  assert.equal(viaWorkflow.lineage?.[0].assetId, "history-82-legacy");
  assert.equal(viaWorkflow.lineage?.[0].jobId, undefined);

  const plain = generationJobHistoryEntry(job({}));
  assert.equal(plain.lineage, undefined); // 沒有線索就不登記——誠實留白給補丁/來源不明態。
});

test("job 參考圖血統：sourceGenerationId 記 derivation（同一事實與 rerun 各自一條）", () => {
  const derived = generationJobHistoryEntry(job({
    workflow: { references: [{ url: "u", mimeType: "image/png", sourceGenerationId: "task-src" }] },
    retryOfTaskId: "task-rerun-of",
  }));
  const kinds = (derived.lineage ?? []).map((link) => link.kind);
  assert.deepEqual(new Set(kinds), new Set(["derivation", "rerun"]));
});

// ─────────────────────────────────────── 抽屜池解析

test("buildLineagePool：jobId/歷史把手/產物 id 三把鍵都解得到記錄", () => {
  const e = entry({
    id: "82-9",
    taskId: "task-9",
    prompt: "池内记录",
    results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/9.png", resultId: "art-9" }],
  });
  const { pool, entries } = buildLineagePool([e], []);
  assert.equal(entries.length, 1);
  assert.equal(pool.find("task-9", undefined)?.label, "池内记录");
  assert.equal(pool.find(undefined, "history-82-9")?.selfHandles.jobId, "task-9");
  assert.equal(pool.find(undefined, "art-9")?.thumbnailUrl, "https://x/9.png");
  assert.equal(pool.find("nope", undefined), null);
});

test("卡與記錄同池：卡 derivation 把手能解回歷史記錄（溯源鏈閉環）", () => {
  const e = entry({ id: "82-9", taskId: "task-9", results: [{ provider: "p", modelId: "m", image: null, imageUrl: "https://x/9.png" }] });
  const card: CharacterCard = {
    id: "card-src",
    name: "锁的卡",
    kind: "character",
    prompt: "",
    references: [{ url: "https://x/9.png", role: "character", name: "锁的卡" }],
    createdAt: T0,
    updatedAt: T0,
    lineage: [{ kind: "derivation", jobId: "task-9", at: T0 }],
  };
  const { pool } = buildLineagePool([e], [card]);
  const cardView = cardToLineageView(card);
  assert.equal(cardView.label, "角色卡：锁的卡");
  const parent = pool.find("task-9", undefined);
  assert.equal(parent?.selfHandles.jobId, "task-9");
  assert.equal(entryToLineageView(e).thumbnailUrl, "https://x/9.png");
});
