import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  listRoutingEvents,
  recordRoutingEvent,
  summarizeRoutingEvents,
  type RoutingEvent,
} from "./routing-telemetry.ts";

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

/**
 * Same file with comments stripped. Negative assertions ("this bug must not come back")
 * have to run against code only — otherwise a comment *explaining* the old bug trips the
 * very guard that documents it.
 */
function readCode(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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

test("summarizeRoutingEvents aggregates per label+host and never counts cancelled as failure", () => {
  const events: RoutingEvent[] = [
    makeEvent({
      ts: 1000,
      attempts: [
        { label: "pool-a", host: "a.example.com", ok: true, ms: 100 },
        { label: "pool-b", host: "b.example.com", ok: false, ms: 50, status: 503, reason: "upstream-503" },
      ],
    }),
    makeEvent({
      ts: 2000,
      attempts: [
        { label: "pool-a", host: "a.example.com", ok: true, ms: 300 },
        // User closed the page mid-flight: the channel did nothing wrong.
        { label: "pool-a", host: "a.example.com", ok: false, ms: 20, reason: "cancelled" },
        // Same label, different host must aggregate separately.
        { label: "pool-a", host: "c.example.com", ok: false, ms: 10, reason: "timeout" },
      ],
      outcome: "cancelled",
    }),
  ];

  const aggregates = summarizeRoutingEvents(events);
  assert.equal(aggregates.length, 3);

  const poolA = aggregates.find((agg) => agg.label === "pool-a" && agg.host === "a.example.com");
  assert.deepEqual(poolA, {
    label: "pool-a",
    host: "a.example.com",
    attempts: 3,
    successes: 2,
    failures: 0,
    cancelled: 1,
    avgOkMs: 200,
    lastOkTs: 2000,
    lastFailTs: null,
  });

  const poolB = aggregates.find((agg) => agg.label === "pool-b");
  assert.deepEqual(poolB, {
    label: "pool-b",
    host: "b.example.com",
    attempts: 1,
    successes: 0,
    failures: 1,
    cancelled: 0,
    // Never succeeded: average latency of successes is unknowable, not zero.
    avgOkMs: null,
    lastOkTs: null,
    lastFailTs: 1000,
  });

  const poolAOtherHost = aggregates.find((agg) => agg.label === "pool-a" && agg.host === "c.example.com");
  assert.deepEqual(poolAOtherHost, {
    label: "pool-a",
    host: "c.example.com",
    attempts: 1,
    successes: 0,
    failures: 1,
    cancelled: 0,
    avgOkMs: null,
    lastOkTs: null,
    lastFailTs: 2000,
  });
});

test("summarizeRoutingEvents returns an empty list for no events", () => {
  assert.deepEqual(summarizeRoutingEvents([]), []);
});

test("memory mode round-trips events and lists them newest-first", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const first = makeEvent({ ts: 1700000000001, requestId: "req-a" });
  const second = makeEvent({ ts: 1700000000003, requestId: "req-b", outcome: "exhausted", refunded: true });
  const third = makeEvent({ ts: 1700000000002, requestId: "req-c", pipeline: "biz", bypassBilling: true });

  await recordRoutingEvent(first);
  await recordRoutingEvent(second);
  await recordRoutingEvent(third);

  const listed = await listRoutingEvents();
  assert.deepEqual(listed.map((event) => event.ts), [1700000000003, 1700000000002, 1700000000001]);
  assert.deepEqual(listed[0], second);
  assert.deepEqual(listed[1], third);
  assert.deepEqual(listed[2], first);

  const limited = await listRoutingEvents(2);
  assert.deepEqual(limited.map((event) => event.requestId), ["req-b", "req-c"]);
});

test("memory mode caps the ring buffer at 100 events and the default list limit is 50", async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const base = 1800000000000;
  for (let i = 0; i < 150; i++) {
    await recordRoutingEvent(makeEvent({ ts: base + i, requestId: `req-ring-${i}` }));
  }

  const all = await listRoutingEvents(200);
  assert.equal(all.length, 100);
  assert.equal(all[0]?.ts, base + 149);
  // Oldest 50 of the 150 (and everything recorded before them) fell off the ring.
  assert.equal(all[all.length - 1]?.ts, base + 50);

  const defaulted = await listRoutingEvents();
  assert.equal(defaulted.length, 50);
  assert.equal(defaulted[0]?.ts, base + 149);
  assert.equal(defaulted[defaulted.length - 1]?.ts, base + 100);
});

test("each event is written to its own timestamped blob path (no read-modify-write races)", () => {
  const code = readCode("src/lib/routing-telemetry.ts");
  assert.match(code, /EVENT_PREFIX = "admin\/routing-events\/"/);
  // One event, one blob, unique pathname: 13-digit zero-padded ts + random hex suffix.
  assert.match(code, /`\$\{EVENT_PREFIX\}\$\{String\(event\.ts\)\.padStart\(13, "0"\)\}-\$\{randomBytes\(4\)\.toString\("hex"\)\}\.json`/);
  // Unique pathnames mean overwrites are impossible; never opt into them.
  assert.doesNotMatch(code, /allowOverwrite:\s*true/);
  // Listing must walk every page — Blob paginates by pathname.
  assert.match(code, /hasMore \? page\.cursor : undefined/);
});

test("recordRoutingEvent never throws and prunes with 5% probability", () => {
  const code = readCode("src/lib/routing-telemetry.ts");
  assert.match(code, /export async function recordRoutingEvent\(event: RoutingEvent\): Promise<void> \{\s*try \{/);
  assert.match(code, /\} catch \(error\) \{\s*console\.error\("\[routing-telemetry\] Failed to record routing event\.", error\);/);
  // Telemetry must never propagate an error into the generation path.
  assert.doesNotMatch(code, /\bthrow\b/);
  assert.match(code, /PRUNE_PROBABILITY = 0\.05/);
  assert.match(code, /Math\.random\(\) < PRUNE_PROBABILITY/);
});

test("record and list share one prune function that trims beyond 400 events", () => {
  const code = readCode("src/lib/routing-telemetry.ts");
  assert.match(code, /MAX_STORED_EVENTS = 400/);
  assert.match(code, /blobs\.length <= MAX_STORED_EVENTS/);
  // One definition plus a call site in both recordRoutingEvent and listRoutingEvents.
  const pruneReferences = code.match(/pruneRoutingEventBlobs\(/g) ?? [];
  assert.ok(pruneReferences.length >= 3, `expected shared prune function referenced 3+ times, saw ${pruneReferences.length}`);
});

test("routing events never contain credentials", () => {
  const code = readCode("src/lib/routing-telemetry.ts");
  // The evidence chain must stay publishable: no key material, ever.
  assert.doesNotMatch(code, /apiKey/);
  assert.doesNotMatch(code, /apikey/i);
});
