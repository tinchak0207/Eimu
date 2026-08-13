import assert from "node:assert/strict";
import test from "node:test";

import {
  billingRetryAt,
  classifyBillingFailure,
  commitGenerationBilling,
  refundGenerationBilling,
} from "./billing-ledger.ts";
import { ImageBillingGatewayError, ImageBillingRevertedError } from "@/lib/image-billing";
import type { GenerationSql } from "./database.ts";
import type { GenerationJob } from "./types.ts";

type Call = { sql: string; values: unknown[] };

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  const now = new Date("2026-07-29T00:00:00.000Z");
  return {
    id: "job-1",
    tenantId: "biz:key-1",
    apiKeyId: "key-1",
    billingUserId: 7,
    source: "biz",
    idempotencyKey: "request-1",
    requestHash: "hash",
    kind: "image_generate",
    routingClass: "generic",
    modelId: "gpt-image-2",
    size: "1024x1024",
    ratio: "1:1",
    resolution: "1k",
    quality: "fast",
    promptCiphertext: "v1.a.b.c",
    workflow: {},
    responseFormat: "url",
    callbackUrl: null,
    status: "failed",
    requestedCount: 1,
    completedCount: 0,
    attemptCount: 1,
    billingAmount: 10,
    deadlineAt: now,
    availableAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    failureClass: "overloaded",
    failureDetail: "provider failed",
    result: null,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mockSql(initialRefundStatus: string, claimed = true) {
  const calls: Call[] = [];
  let refundStatus = initialRefundStatus;
  const tagged = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    calls.push({ sql, values });
    if (sql.includes("SELECT * FROM billing_operation")) {
      return [{ id: "refund-1", amount: 10, status: refundStatus, attempt_count: 0 }];
    }
    if (sql.includes("attempt_count = attempt_count + 1")) {
      return claimed && refundStatus === "pending"
        ? [{ id: "refund-1", amount: 10, status: "executing", attempt_count: 1 }]
        : [];
    }
    if (sql.includes("SET status = 'applied'")) {
      refundStatus = "applied";
      return [{ id: "refund-1" }];
    }
    if (sql.includes("SET status = 'unknown'")) {
      refundStatus = "unknown";
      return [];
    }
    if (sql.includes("SET status = 'pending'")) {
      refundStatus = "pending";
      return [];
    }
    return [];
  }) as unknown as GenerationSql;
  (tagged as unknown as { begin: (cb: (tx: GenerationSql) => Promise<unknown>) => Promise<unknown> }).begin =
    (cb) => cb(tagged);
  return { sql: tagged, calls };
}

test("only explicit client rejections or 429 are safe billing retries", () => {
  assert.equal(classifyBillingFailure(new ImageBillingGatewayError("rate limited", 429, "45")), "retry");
  assert.equal(classifyBillingFailure(new ImageBillingGatewayError("insufficient quota", 402)), "rejected");
  assert.equal(classifyBillingFailure(new ImageBillingGatewayError("gateway unavailable", 503)), "unknown");
  assert.equal(classifyBillingFailure(new TypeError("fetch failed")), "unknown");
  assert.equal(classifyBillingFailure(new ImageBillingRevertedError("compensated")), "retry");
});

test("429 retry timing honors Retry-After and retry delay is bounded", () => {
  const now = new Date("2026-07-29T00:00:00.000Z");
  assert.equal(
    billingRetryAt(new ImageBillingGatewayError("rate limited", 429, "120"), 1, now).toISOString(),
    "2026-07-29T00:02:00.000Z",
  );
  assert.ok(billingRetryAt(new ImageBillingGatewayError("rate limited", 429), 99, now).getTime() - now.getTime() <= 300_000);
});

test("full refund transitions the job once and never repeats a successful external credit", async () => {
  const { sql, calls } = mockSql("pending");
  let refunds = 0;
  const result = await refundGenerationBilling({
    job: job(),
    executorId: "worker-a",
    adapter: {
      reserve: async () => {},
      refund: async () => { refunds += 1; },
    },
  }, sql);
  assert.equal(result, "applied");
  assert.equal(refunds, 1);
  assert.ok(calls.some((call) => call.sql.includes("status = 'refunded'")));

  const alreadyApplied = mockSql("applied");
  const second = await refundGenerationBilling({
    job: job(),
    executorId: "worker-b",
    adapter: {
      reserve: async () => {},
      refund: async () => { throw new Error("must not call gateway again"); },
    },
  }, alreadyApplied.sql);
  assert.equal(second, "applied");
});

test("an ambiguous refund is frozen and a later retry does not issue a second credit", async () => {
  const { sql } = mockSql("pending");
  let refunds = 0;
  const adapter = {
    reserve: async () => {},
    refund: async () => {
      refunds += 1;
      throw new TypeError("network failed after send");
    },
  };
  const first = await refundGenerationBilling({ job: job(), executorId: "worker-a", adapter }, sql);
  assert.equal(first, "unknown");
  const second = await refundGenerationBilling({ job: job(), executorId: "worker-b", adapter }, sql);
  assert.equal(second, "unknown");
  assert.equal(refunds, 1);
});

test("commit is recorded only against an applied reserve operation", async () => {
  const calls: Call[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join(" "), values });
    return [];
  }) as unknown as GenerationSql;

  await commitGenerationBilling(job({ status: "succeeded" }), 10, sql);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /reserve\.status = 'applied'/);
  assert.match(calls[0].sql, /ON CONFLICT \(job_id, operation, sequence\) DO NOTHING/);
});

