import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getRuntimeChannelOverrides,
  invalidateChannelOverridesCache,
  normalizeChannelOverrides,
  readChannelOverrides,
  writeChannelOverrides,
  type ChannelOverride,
  type ChannelOverrides,
} from "./channel-overrides.ts";

const root = process.cwd();
const SOURCE_PATH = "src/lib/channel-overrides.ts";

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

const env = process.env as Record<string, string | undefined>;

function withMemoryMode(nodeEnv: string | undefined, fn: () => Promise<void>): Promise<void> {
  const savedToken = env.BLOB_READ_WRITE_TOKEN;
  const savedNodeEnv = env.NODE_ENV;
  delete env.BLOB_READ_WRITE_TOKEN;
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  invalidateChannelOverridesCache();

  return fn().finally(() => {
    if (savedToken === undefined) delete env.BLOB_READ_WRITE_TOKEN;
    else env.BLOB_READ_WRITE_TOKEN = savedToken;
    if (savedNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = savedNodeEnv;
    invalidateChannelOverridesCache();
  });
}

test("normalizeChannelOverrides rejects non-object roots", () => {
  assert.deepEqual(normalizeChannelOverrides(null), {});
  assert.deepEqual(normalizeChannelOverrides(undefined), {});
  assert.deepEqual(normalizeChannelOverrides("enabled"), {});
  assert.deepEqual(normalizeChannelOverrides(42), {});
  assert.deepEqual(normalizeChannelOverrides(true), {});
  assert.deepEqual(normalizeChannelOverrides([{ enabled: true }]), {});
});

test("normalizeChannelOverrides keeps only valid enabled/priority fields", () => {
  assert.deepEqual(
    normalizeChannelOverrides({
      keepsBoth: { enabled: false, priority: 0 },
      keepsBoundary: { priority: 99 },
      stripsExtra: { enabled: true, priority: 5, apiKey: "sk-should-vanish" },
      badPriorityKeepsEnabled: { enabled: true, priority: 100 },
    }),
    {
      keepsBoth: { enabled: false, priority: 0 },
      keepsBoundary: { priority: 99 },
      stripsExtra: { enabled: true, priority: 5 },
      badPriorityKeepsEnabled: { enabled: true },
    },
  );
});

test("normalizeChannelOverrides drops entries with no valid field", () => {
  assert.deepEqual(
    normalizeChannelOverrides({
      notObject: "on",
      nullEntry: null,
      arrayEntry: [true],
      empty: {},
      stringEnabled: { enabled: "true" },
      numberEnabled: { enabled: 1 },
      negativePriority: { priority: -1 },
      tooBig: { priority: 100 },
      float: { priority: 2.5 },
      nan: { priority: Number.NaN },
      stringPriority: { priority: "5" },
    }),
    {},
  );
});

test("normalizeChannelOverrides survives an own __proto__ key without prototype pollution", () => {
  const raw: unknown = JSON.parse('{"__proto__": {"enabled": false}, "ok": {"enabled": true}}');
  const result = normalizeChannelOverrides(raw);

  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result, "__proto__")?.value, { enabled: false });
  assert.deepEqual(result.ok, { enabled: true });
  assert.equal(({} as { enabled?: unknown }).enabled, undefined);
});

test("memory mode: write/read roundtrip with null read version and 'memory' write version", () =>
  withMemoryMode(undefined, async () => {
    const written = await writeChannelOverrides({
      "gemini-pool": { enabled: false, priority: 7 },
      "firefly": { priority: 12 },
      "empty-entry-dropped": {},
    });
    assert.deepEqual(written, { version: "memory" });

    const expected: ChannelOverrides = {
      "gemini-pool": { enabled: false, priority: 7 },
      "firefly": { priority: 12 },
    };

    const readBack = await readChannelOverrides();
    assert.deepEqual(readBack, { overrides: expected, version: null });

    const fresh = await readChannelOverrides({ fresh: true });
    assert.deepEqual(fresh, { overrides: expected, version: null });

    assert.deepEqual(await getRuntimeChannelOverrides(), expected);
  }));

test("memory mode: write normalizes garbage entries before storing", () =>
  withMemoryMode(undefined, async () => {
    await writeChannelOverrides({
      good: { priority: 3 },
      bad: { enabled: "nope" } as unknown as ChannelOverride,
    });
    const { overrides } = await readChannelOverrides();
    assert.deepEqual(overrides, { good: { priority: 3 } });
  }));

test("memory mode: callers cannot mutate the stored map through a read result", () =>
  withMemoryMode(undefined, async () => {
    await writeChannelOverrides({ stable: { enabled: true } });
    const first = await readChannelOverrides();
    first.overrides.injected = { enabled: false };
    const second = await readChannelOverrides();
    assert.deepEqual(second.overrides, { stable: { enabled: true } });
  }));

test("production without BLOB_READ_WRITE_TOKEN refuses to write", () =>
  withMemoryMode("production", async () => {
    await assert.rejects(() => writeChannelOverrides({ a: { enabled: true } }), /BLOB_READ_WRITE_TOKEN/);
  }));

test("blob layout: immutable timestamped pathnames under the v1 prefix", () => {
  const code = readCode(SOURCE_PATH);
  assert.match(code, /const STORE_PREFIX = "admin\/channel-overrides\.v1"/);
  assert.match(code, /`\$\{STORE_PREFIX\}-\$\{Date\.now\(\)\}-\$\{randomBytes\(4\)\.toString\("hex"\)\}\.json`/);
  assert.match(code, /cacheControlMaxAge:\s*60/);
  assert.doesNotMatch(code, /allowOverwrite:\s*true/);
});

test("blob reads walk every list() page and never cap at limit:100", () => {
  const code = readCode(SOURCE_PATH);
  assert.doesNotMatch(code, /limit:\s*100/);
  assert.match(code, /list\(\{ prefix: STORE_PREFIX, cursor, abortSignal: AbortSignal\.timeout\(OVERRIDES_BLOB_TIMEOUT_MS\) \}\)/);
  assert.match(code, /page\.hasMore \? page\.cursor : undefined/);
  assert.match(code, /do \{[\s\S]*?\} while \(cursor\)/);
});

test("writes prune to the newest generations and swallow del failures", () => {
  const code = readCode(SOURCE_PATH);
  assert.match(code, /OVERRIDE_BLOB_GENERATIONS_KEPT = 3/);
  assert.match(code, /slice\(OVERRIDE_BLOB_GENERATIONS_KEPT - 1\)/);
  assert.match(code, /await del\(.*\)\.catch\(/);
});

test("reads use a 15s cache that fresh:true bypasses, invalidated after writes", () => {
  const code = readCode(SOURCE_PATH);
  assert.match(code, /OVERRIDE_CACHE_TTL_MS = 15_000/);
  assert.match(code, /!options\?\.fresh && overrideCache && overrideCache\.expiresAt > now/);
  const writeFn = code.match(/export async function writeChannelOverrides[\s\S]*?\n\}/)?.[0];
  assert.ok(writeFn, "writeChannelOverrides not found in source");
  assert.match(writeFn, /invalidateChannelOverridesCache\(\)/);
});

test("fail-closed: runtime read failures serve last-known-good, never a fresh empty literal", () => {
  const code = readCode(SOURCE_PATH);

  // The backstop lives at module level and is only overwritten by a successful fetch.
  assert.match(code, /^let lastKnownGoodOverrides: ChannelOverrides = \{\};$/m);
  assert.match(code, /lastKnownGoodOverrides = overrides;/);

  // Cache invalidation must not clear the backstop — it outlives the 15s TTL.
  const invalidateFn = code.match(/export function invalidateChannelOverridesCache[\s\S]*?\n\}/)?.[0];
  assert.ok(invalidateFn, "invalidateChannelOverridesCache not found in source");
  assert.doesNotMatch(invalidateFn, /lastKnownGoodOverrides/);

  const runtimeFn = code.match(/export async function getRuntimeChannelOverrides[\s\S]*?\n\}/)?.[0];
  assert.ok(runtimeFn, "getRuntimeChannelOverrides not found in source");
  const catchBlock = runtimeFn.match(/catch[\s\S]*/)?.[0];
  assert.ok(catchBlock, "getRuntimeChannelOverrides has no catch path");
  assert.match(catchBlock, /console\.error/);
  assert.match(catchBlock, /lastKnownGoodOverrides/);
  // A blank fallback would silently resurrect channels the admin disabled.
  assert.doesNotMatch(catchBlock, /return\s*\{\s*\}/);
  assert.doesNotMatch(catchBlock, /return\s*\{\s*overrides:\s*\{\s*\}/);

  // A listed-but-unreadable latest blob must throw (fail closed), not read as "no overrides".
  const fetchFn = code.match(/async function fetchChannelOverrides[\s\S]*?\n\}/)?.[0];
  assert.ok(fetchFn, "fetchChannelOverrides not found in source");
  assert.match(fetchFn, /statusCode !== 200/);
  assert.match(fetchFn, /throw new Error/);
});
