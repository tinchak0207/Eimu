import test from "node:test";
import assert from "node:assert/strict";

import { diffJson, getConfigChangeSnapshot, listConfigChanges, recordConfigChange } from "./admin-audit.ts";
import type { GenerationSql } from "./generation-core/database.ts";

test("diffJson: shallow top-level diff ignores unchanged keys, reports added/removed/changed", () => {
  const before = { a: { enabled: true }, b: { priority: 1 }, c: { enabled: false } };
  const after = { a: { enabled: true }, b: { priority: 2 }, d: { enabled: true } };

  assert.deepEqual(diffJson(before, after), {
    b: { before: { priority: 1 }, after: { priority: 2 } },
    c: { before: { enabled: false }, after: undefined },
    d: { before: undefined, after: { enabled: true } },
  });
});

test("diffJson: nested changes inside an unchanged-looking key still surface (shallow but value-aware)", () => {
  const before = { channel: { enabled: true, nested: { priority: 1 } } };
  const after = { channel: { enabled: true, nested: { priority: 2 } } };

  assert.deepEqual(diffJson(before, after), {
    channel: {
      before: { enabled: true, nested: { priority: 1 } },
      after: { enabled: true, nested: { priority: 2 } },
    },
  });
});

test("diffJson: identical objects produce an empty diff", () => {
  const value = { a: { enabled: true } };
  assert.deepEqual(diffJson(value, { a: { enabled: true } }), {});
});

test("diffJson: non-object inputs are treated as empty objects, not thrown", () => {
  assert.deepEqual(diffJson(null, { a: 1 }), { a: { before: undefined, after: 1 } });
  assert.deepEqual(diffJson(undefined, undefined), {});
  assert.deepEqual(diffJson([1, 2], { a: 1 }), { a: { before: undefined, after: 1 } });
});

/**
 * Minimal stand-in for the `postgres` tagged-template client. Callable as
 * `sql\`...\`` and `sql<T[]>\`...\`` (the generic is erased at runtime), which is
 * all admin-audit.ts uses. `throwOnQuery` simulates a live-but-failing connection.
 */
function makeMockSql(options: { rows?: unknown[]; throwOnQuery?: boolean } = {}): GenerationSql {
  const fn = (async () => {
    if (options.throwOnQuery) throw new Error("simulated connection failure");
    return options.rows ?? [];
  }) as unknown as GenerationSql;
  return fn;
}

test("recordConfigChange: fails soft (does not throw) when sql simulates 'not configured' via undefined", async () => {
  // No sql passed and no GENERATION_DATABASE_URL/DATABASE_URL in this test env:
  // resolveSql() must fall back to "not configured" and recordConfigChange must
  // return without throwing.
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;

  await assert.doesNotReject(
    recordConfigChange({
      configKey: "channel-overrides",
      version: 1,
      actor: null,
      action: "update",
      previousVersion: null,
      diff: { a: { before: 1, after: 2 } },
      fullSnapshot: { a: 2 },
    }),
  );
});

test("recordConfigChange: fails soft when the injected sql mock throws mid-query", async () => {
  const sql = makeMockSql({ throwOnQuery: true });

  await assert.doesNotReject(
    recordConfigChange(
      {
        configKey: "channel-overrides",
        version: 2,
        actor: "tinchak0207",
        action: "update",
        previousVersion: 1,
        diff: {},
        fullSnapshot: {},
      },
      sql,
    ),
  );
});

test("listConfigChanges: maps rows newest-first and defaults actor to 'unknown'", async () => {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  const sql = makeMockSql({
    rows: [
      {
        id: "id-2",
        config_key: "channel-overrides",
        version: 2,
        actor: null,
        action: "update",
        previous_version: 1,
        diff_json: { a: { before: 1, after: 2 } },
        full_snapshot_json: { a: 2 },
        created_at: createdAt,
      },
      {
        id: "id-1",
        config_key: "channel-overrides",
        version: 1,
        actor: "tinchak0207",
        action: "update",
        previous_version: null,
        diff_json: {},
        full_snapshot_json: { a: 1 },
        created_at: createdAt,
      },
    ],
  });

  const result = await listConfigChanges("channel-overrides", 10, sql);
  assert.equal(result.length, 2);
  assert.equal(result[0].version, 2);
  assert.equal(result[0].actor, "unknown");
  assert.equal(result[1].version, 1);
  assert.equal(result[1].actor, "tinchak0207");
  assert.equal(result[1].previousVersion, null);
});

test("listConfigChanges: query failure returns an empty array instead of throwing", async () => {
  const sql = makeMockSql({ throwOnQuery: true });
  const result = await listConfigChanges("channel-overrides", 10, sql);
  assert.deepEqual(result, []);
});

test("getConfigChangeSnapshot: returns the snapshot for a known version", async () => {
  const sql = makeMockSql({ rows: [{ full_snapshot_json: { channelA: { enabled: false } } }] });
  const snapshot = await getConfigChangeSnapshot("channel-overrides", 3, sql);
  assert.deepEqual(snapshot, { channelA: { enabled: false } });
});

test("getConfigChangeSnapshot: returns null when the version has no row", async () => {
  const sql = makeMockSql({ rows: [] });
  const snapshot = await getConfigChangeSnapshot("channel-overrides", 999, sql);
  assert.equal(snapshot, null);
});

test("getConfigChangeSnapshot: query failure returns null instead of throwing", async () => {
  const sql = makeMockSql({ throwOnQuery: true });
  const snapshot = await getConfigChangeSnapshot("channel-overrides", 1, sql);
  assert.equal(snapshot, null);
});
