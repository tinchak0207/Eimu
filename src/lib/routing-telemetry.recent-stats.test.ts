import test from "node:test";
import assert from "node:assert/strict";

import { summarizeRecentModelStats, type RoutingEvent } from "./routing-telemetry.ts";

function makeEvent(overrides: Partial<RoutingEvent> = {}): RoutingEvent {
  return {
    id: `evt-${Math.random().toString(16).slice(2)}`,
    ts: 1700000000000,
    requestId: "req-test",
    pipeline: "user",
    modelId: "gpt-image-2",
    qualityMode: "standard",
    queue: [{ label: "pool-a", host: "a.example.com", priority: 10 }],
    attempts: [],
    outcome: "delivered",
    totalMs: 1200,
    coins: 4,
    refunded: false,
    ...overrides,
  };
}

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

test("summarizeRecentModelStats counts delivered as success, all other outcomes as failed", () => {
  const events: RoutingEvent[] = [
    makeEvent({ modelId: "model-a", ts: NOW - 2 * HOUR, outcome: "delivered" }),
    makeEvent({ modelId: "model-a", ts: NOW - 3 * HOUR, outcome: "delivered" }),
    makeEvent({ modelId: "model-a", ts: NOW - 4 * HOUR, outcome: "exhausted", refunded: true }),
    makeEvent({ modelId: "model-a", ts: NOW - 5 * HOUR, outcome: "cancelled" }),
    // Different model, all failures, no refunds.
    makeEvent({ modelId: "model-b", ts: NOW - 1 * HOUR, outcome: "exhausted" }),
    makeEvent({ modelId: "model-b", ts: NOW - 2 * HOUR, outcome: "no-endpoints" }),
  ];

  const stats = summarizeRecentModelStats(events, NOW);

  const modelA = stats.find((s) => s.modelId === "model-a");
  assert.ok(modelA);
  assert.equal(modelA.jobs, 4);
  assert.equal(modelA.delivered, 2);
  assert.equal(modelA.failed, 2);
  assert.equal(modelA.refunded, 1);
  assert.equal(modelA.success_rate, 0.5);

  const modelB = stats.find((s) => s.modelId === "model-b");
  assert.ok(modelB);
  assert.equal(modelB.jobs, 2);
  assert.equal(modelB.delivered, 0);
  assert.equal(modelB.failed, 2);
  assert.equal(modelB.refunded, 0);
  assert.equal(modelB.success_rate, 0);
});

test("summarizeRecentModelStats drops events outside the 24h window", () => {
  const events: RoutingEvent[] = [
    makeEvent({ modelId: "model-a", ts: NOW - 23 * HOUR, outcome: "delivered" }),
    // Just outside the window: must not count.
    makeEvent({ modelId: "model-a", ts: NOW - 25 * HOUR, outcome: "delivered" }),
  ];

  const stats = summarizeRecentModelStats(events, NOW);
  assert.equal(stats.length, 1);
  assert.equal(stats[0]?.jobs, 1);
  assert.equal(stats[0]?.delivered, 1);
  assert.equal(stats[0]?.success_rate, 1);
});

test("summarizeRecentModelStats accepts a custom window and honors exact boundary", () => {
  const events: RoutingEvent[] = [
    // ts == cutoff (NOW - window) is inside: window is inclusive (ts >= cutoff).
    makeEvent({ modelId: "model-a", ts: NOW - 2 * HOUR, outcome: "delivered" }),
  ];
  const stats = summarizeRecentModelStats(events, NOW, 2 * HOUR);
  assert.equal(stats[0]?.jobs, 1);
});

test("summarizeRecentModelStats returns [] for no events in window", () => {
  assert.deepEqual(summarizeRecentModelStats([], NOW), []);
  // Even events exist but all out of window.
  assert.deepEqual(summarizeRecentModelStats([makeEvent({ ts: NOW - 48 * HOUR })], NOW), []);
});

test("summarizeRecentModelStats sorts by jobs descending", () => {
  const events: RoutingEvent[] = [
    makeEvent({ modelId: "few", ts: NOW - HOUR, outcome: "delivered" }),
    makeEvent({ modelId: "many", ts: NOW - HOUR, outcome: "delivered" }),
    makeEvent({ modelId: "many", ts: NOW - 2 * HOUR, outcome: "exhausted" }),
  ];
  const stats = summarizeRecentModelStats(events, NOW);
  assert.deepEqual(stats.map((s) => s.modelId), ["many", "few"]);
});
