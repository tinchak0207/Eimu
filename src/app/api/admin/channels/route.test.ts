import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeChannelOverrides } from "../../../../lib/channel-overrides.ts";
import { overridableChannelIds } from "../../../../lib/channel-registry.ts";

const root = process.cwd();

const CHANNELS_ROUTE = "src/app/api/admin/channels/route.ts";
const PROBE_ROUTE = "src/app/api/admin/channels/probe/route.ts";
const EVENTS_ROUTE = "src/app/api/admin/routing-events/route.ts";

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

test("channels route never serializes gateway secrets", () => {
  const code = readCode(CHANNELS_ROUTE);

  // The queue endpoints carry channel secrets; the response construction may only
  // ever pick label/host/priority. The secret field name must not appear anywhere
  // in the route's code.
  assert.doesNotMatch(code, /apiKey/);
  // Hosts go through the sanitizer, never raw base URLs into the payload.
  assert.match(code, /safeEndpointHost\(/);
  // envPresence must stay booleans-only; no env *values* may be echoed back.
  assert.match(code, /Boolean\(process\.env\[key\]\?\.trim\(\)\)/);
});

test("channels route derives channels and queues from the shared registry", () => {
  const code = readCode(CHANNELS_ROUTE);

  // Same-source invariant: what /admin displays must come from the exact functions
  // production routing uses, fed with one shared pools+overrides read.
  assert.match(code, /from "@\/lib\/channel-registry"/);
  assert.match(code, /buildModelQueue\(/);
  assert.match(code, /describeChannels\(/);
  assert.match(code, /readAdminPools\(\)/);
  assert.match(code, /SUPPORTED_IMAGE_MODEL_IDS/);
  assert.match(code, /requireAdminSession\(\)/);
  // The historical SUB2API_ENABLED trap must be surfaced as a tri-state.
  assert.match(code, /set-but-not-true/);
  assert.match(code, /missing/);
});

test("channels PATCH enforces the optimistic-concurrency version gate", () => {
  const code = readCode(CHANNELS_ROUTE);

  assert.match(code, /expectedVersion/);
  assert.match(code, /409/);
  // The gate must compare against a cache-bypassing read, not the 15s cache.
  assert.match(code, /readChannelOverrides\(\{\s*fresh:\s*true\s*\}\)/);
  assert.match(code, /writeChannelOverrides\(/);
  // Whitelisting happens in the route (the store only validates shape).
  assert.match(code, /overridableChannelIds\(\)/);
  assert.match(code, /normalizeChannelOverrides\(/);
});

test("PATCH whitelist drops pool ids, junk keys, and malformed entries", () => {
  // Mirrors the route's filter: normalize the shape, then keep only overridable ids.
  function filterToOverridable(raw: unknown) {
    const allowed = new Set(overridableChannelIds());
    return Object.fromEntries(
      Object.entries(normalizeChannelOverrides(raw)).filter(([id]) => allowed.has(id)),
    );
  }

  const filtered = filterToOverridable({
    "env:sub2api": { enabled: false },
    "env:adobe2api": { priority: 12 },
    "pool:abc123": { enabled: false }, // pools have their own CRUD — must be dropped
    garbage: { enabled: true }, // unknown id — dropped
    "env:not-a-channel": { priority: 5 }, // unknown env id — dropped
    "env:primary": { priority: 120 }, // out of range — dropped by normalization
    "env:fallback": { enabled: "yes" }, // wrong type — dropped by normalization
  });

  assert.deepEqual(filtered, {
    "env:sub2api": { enabled: false },
    "env:adobe2api": { priority: 12 },
  });

  // The whitelist itself must never contain pool ids, and must cover every env channel.
  const allowed = overridableChannelIds();
  assert.ok(allowed.every((id) => !id.startsWith("pool:")));
  assert.ok(allowed.includes("env:pixai"));
});

test("probe route probes /models only and is honest about unprobeable channels", () => {
  const code = readCode(PROBE_ROUTE);

  assert.match(code, /requireAdminSession\(\)/);
  assert.match(code, /\/models/);
  assert.match(code, /AbortSignal\.timeout\(10_000\)/);
  // Channels without a /models endpoint (e.g. the browser relay) must be labeled
  // "unsupported" instead of faking an always-red probe.
  assert.match(read(PROBE_ROUTE), /此渠道不支持 \/models 探测/);
  assert.match(code, /supported:\s*false/);
  // A probe must never trigger a real (billable) generation.
  assert.doesNotMatch(code, /images\/generations/);
});

test("routing-events route reads telemetry through the shared module and labels its window", () => {
  const code = readCode(EVENTS_ROUTE);

  assert.match(code, /requireAdminSession\(\)/);
  assert.match(code, /listRoutingEvents\(/);
  assert.match(code, /summarizeRoutingEvents\(/);
  assert.match(code, /parsed < 1 \|\| parsed > 200/);
  assert.match(read(EVENTS_ROUTE), /统计窗口：最近 \$\{events\.length\} 条事件/);
});
