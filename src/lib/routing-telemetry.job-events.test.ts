import test from "node:test";
import assert from "node:assert/strict";

import { buildJobRoutingEvent, type RoutingEvent } from "./routing-telemetry.ts";
import type { GenerationAttemptSummary } from "./generation-core/job-repository.ts";
import type { GenerationJob } from "./generation-core/types.ts";

const FIXED_CREATED_AT = new Date("2026-08-07T00:00:00.000Z");

function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: "job-route-1",
    tenantId: "web:user-1",
    apiKeyId: null,
    billingUserId: null,
    source: "web",
    idempotencyKey: null,
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
    retryOfTaskId: null,
    primaryResultId: null,
    status: "succeeded",
    requestedCount: 1,
    completedCount: 1,
    attemptCount: 2,
    billingAmount: 8,
    deadlineAt: FIXED_CREATED_AT,
    availableAt: FIXED_CREATED_AT,
    leaseOwner: null,
    leaseExpiresAt: null,
    failureClass: null,
    failureDetail: null,
    result: null,
    createdAt: FIXED_CREATED_AT,
    startedAt: FIXED_CREATED_AT,
    finishedAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
    ...overrides,
  };
}

function attempt(overrides: Partial<GenerationAttemptSummary> = {}): GenerationAttemptSummary {
  return {
    attemptNo: 1,
    outputIndex: 0,
    status: "succeeded",
    providerHttpStatus: 200,
    latencyMs: 5000,
    failureClass: null,
    supplierLabel: "sub2api-1",
    supplierBaseUrl: "https://sub2api.example",
    ...overrides,
  };
}

test("buildJobRoutingEvent maps a delivered job (fail then succeed) into a user pipeline event", () => {
  const event: RoutingEvent = buildJobRoutingEvent(
    job(),
    [
      attempt({
        attemptNo: 1,
        status: "failed",
        providerHttpStatus: 429,
        latencyMs: 1000,
        failureClass: "rate_limited",
        supplierLabel: "pixai",
        supplierBaseUrl: "https://store.eimu.dev",
      }),
      attempt({
        attemptNo: 2,
        status: "succeeded",
        providerHttpStatus: 200,
        latencyMs: 5000,
        failureClass: null,
        supplierLabel: "sub2api-1",
        supplierBaseUrl: "https://sub2api.example",
      }),
    ],
    "delivered",
    false,
  );

  assert.equal(event.outcome, "delivered");
  assert.equal(event.deliveredBy, "sub2api-1");
  assert.equal(event.attempts.length, 2);
  assert.equal(event.attempts[1].ok, true);
  assert.equal(event.attempts[0].ok, false);
  assert.equal(event.attempts[0].status, 429);
  assert.equal(event.attempts[0].reason, "rate_limited");
  assert.deepEqual(event.queue.map((entry) => entry.label), ["pixai", "sub2api-1"]);
  assert.deepEqual(event.queue.map((entry) => entry.host), ["store.eimu.dev", "sub2api.example"]);
  assert.equal(event.pipeline, "user");
  assert.equal(event.requestId, "job-route-1");
  assert.equal(event.modelId, "gpt-image-2");
  assert.equal(event.qualityMode, "fast");
  assert.equal(event.resolution, "1k");
  assert.equal(event.coins, 8);
  assert.equal(event.refunded, false);
  assert.equal(event.attempts[1].ms, 5000);
});

test("buildJobRoutingEvent marks a single failed attempt as exhausted with a refund and no deliveredBy", () => {
  const event: RoutingEvent = buildJobRoutingEvent(
    job(),
    [
      attempt({
        status: "failed",
        providerHttpStatus: 503,
        latencyMs: 800,
        failureClass: "upstream_unavailable",
        supplierLabel: "pixai",
        supplierBaseUrl: "https://store.eimu.dev",
      }),
    ],
    "exhausted",
    true,
  );

  assert.equal(event.outcome, "exhausted");
  assert.equal(event.refunded, true);
  assert.equal(event.deliveredBy, undefined);
  assert.equal(event.attempts.length, 1);
  assert.equal(event.attempts[0].ok, false);
  assert.equal(event.attempts[0].reason, "upstream_unavailable");
  assert.equal(event.queue.length, 1);
});

test("buildJobRoutingEvent maps biz-sourced jobs to the biz pipeline (canary stays user)", () => {
  const bizEvent: RoutingEvent = buildJobRoutingEvent(job({ source: "biz" }), [], "delivered", false);
  assert.equal(bizEvent.pipeline, "biz");
  const canaryEvent: RoutingEvent = buildJobRoutingEvent(job({ source: "canary" }), [], "exhausted", true);
  assert.equal(canaryEvent.pipeline, "user");
});

test("buildJobRoutingEvent falls back quality mode and omits resolution when absent", () => {
  const event: RoutingEvent = buildJobRoutingEvent(
    job({ quality: null, resolution: null }),
    [],
    "exhausted",
    true,
  );
  assert.equal(event.qualityMode, "fast");
  assert.equal(event.resolution, undefined);
  assert.ok(event.id.endsWith("-" + "job-route-1"));
});

test("buildJobRoutingEvent exposes imageUrls only for real artifact urls and omits the field when result is missing", () => {
  const withImages: RoutingEvent = buildJobRoutingEvent(
    job({
      result: {
        created: Date.now(),
        artifacts: [
          { id: "a1", outputIndex: 0, url: "https://cdn.example.com/1.png", mimeType: "image/png", sha256: "x", width: 1024, height: 1024, endpointLabel: "sub2api-1" },
          { id: "a2", outputIndex: 1, url: null, mimeType: "image/png", sha256: "y", width: 1024, height: 1024, endpointLabel: "sub2api-1" },
        ],
      },
    }),
    [attempt({ supplierLabel: "sub2api-1" })],
    "delivered",
    false,
  );
  assert.deepEqual(withImages.imageUrls, ["https://cdn.example.com/1.png"]);

  const withoutResult: RoutingEvent = buildJobRoutingEvent(job(), [], "exhausted", true);
  assert.equal(withoutResult.imageUrls, undefined);
});
