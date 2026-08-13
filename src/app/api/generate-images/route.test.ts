import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildGatewayEndpoints, describeEnvChannels, shouldBypassAuthForLocalTest } from "../../../lib/sub2api.ts";
import { ADOBE2API_MODEL_IDS } from "../../../lib/image-model-ids.js";

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

test("buildGatewayEndpoints prefers sub2api and appends fallback image api endpoint", () => {
  const endpoints = buildGatewayEndpoints({
    SUB2API_ENABLED: "true",
    SUB2API_BASE_URL: "http://127.0.0.1:3000/v1",
    SUB2API_API_KEY: "sk-test",
    IMAGE_API_BASE_URL_FALLBACK: "https://fallback.example/v1",
    IMAGE_API_KEY_FALLBACK: "fallback-key",
  });

  assert.deepEqual(endpoints, [
    {
      apiKey: "sk-test",
      baseURL: "http://127.0.0.1:3000/v1",
      label: "sub2api",
    },
    {
      apiKey: "fallback-key",
      baseURL: "https://fallback.example/v1",
      label: "fallback",
    },
  ]);
});

test("buildGatewayEndpoints falls back to image api endpoints", () => {
  const endpoints = buildGatewayEndpoints({
    IMAGE_API_BASE_URL: "https://primary.example/v1",
    IMAGE_API_KEY: "primary-key",
    IMAGE_API_BASE_URL_FALLBACK: "https://fallback.example/v1",
    IMAGE_API_KEY_FALLBACK: "fallback-key",
  });

  assert.deepEqual(endpoints, [
    {
      apiKey: "primary-key",
      baseURL: "https://primary.example/v1",
      label: "primary",
    },
    {
      apiKey: "fallback-key",
      baseURL: "https://fallback.example/v1",
      label: "fallback",
    },
  ]);
});

test("buildGatewayEndpoints supports per-endpoint image model overrides", () => {
  const endpoints = buildGatewayEndpoints({
    IMAGE_API_BASE_URL: "https://primary.example/v1",
    IMAGE_API_KEY: "primary-key",
    IMAGE_API_MODEL: "codex-gpt-image-2",
    IMAGE_API_BASE_URL_FALLBACK: "https://fallback.example/v1",
    IMAGE_API_KEY_FALLBACK: "fallback-key",
    IMAGE_API_MODEL_FALLBACK: "gpt-image-1",
  });

  assert.deepEqual(endpoints, [
    {
      apiKey: "primary-key",
      baseURL: "https://primary.example/v1",
      label: "primary",
      modelId: "codex-gpt-image-2",
    },
    {
      apiKey: "fallback-key",
      baseURL: "https://fallback.example/v1",
      label: "fallback",
      modelId: "gpt-image-1",
    },
  ]);
});

test("buildGatewayEndpoints uses configured image api endpoint in production", () => {
  const endpoints = buildGatewayEndpoints({
    NODE_ENV: "production",
    IMAGE_API_BASE_URL: "https://primary.example/v1",
    IMAGE_API_KEY: "primary-key",
  });

  assert.deepEqual(endpoints, [
    {
      apiKey: "primary-key",
      baseURL: "https://primary.example/v1",
      label: "primary",
    },
  ]);
});

test("Adobe 3P proxy is opt-in and exposes only the third-party image models", () => {
  const env = {
    ADOBE2API_ENABLED: "true",
    ADOBE2API_BASE_URL: "https://adobe2api.example/",
    ADOBE2API_API_KEY: "adobe2api-key",
  };
  const channel = describeEnvChannels(env).find((item) => item.label === "adobe2api");

  assert.deepEqual(channel, {
    id: "env:adobe2api",
    label: "adobe2api",
    configured: true,
    defaultEnabled: true,
    source: "ADOBE2API_BASE_URL",
    usesBillingGateway: false,
    endpoint: {
      apiKey: "adobe2api-key",
      baseURL: "https://adobe2api.example/v1",
      label: "adobe2api",
      protocol: "adobe2api",
      supportedModels: ADOBE2API_MODEL_IDS,
    },
  });
  assert.equal(
    describeEnvChannels({ ...env, ADOBE2API_BASE_URL: "https://adobe2api.example/v1/" })
      .find((item) => item.label === "adobe2api")?.endpoint?.baseURL,
    "https://adobe2api.example/v1",
  );
  assert.equal(describeEnvChannels({ ...env, ADOBE2API_ENABLED: "false" }).find((item) => item.label === "adobe2api")?.defaultEnabled, false);
});

test("shouldBypassAuthForLocalTest only enables bypass when explicitly configured", () => {
  assert.equal(shouldBypassAuthForLocalTest({ NEXT_PUBLIC_LOCAL_TEST_MODE: "true" }), true);
  assert.equal(shouldBypassAuthForLocalTest({ NEXT_PUBLIC_LOCAL_TEST_MODE: "false" }), false);
  assert.equal(shouldBypassAuthForLocalTest({}), false);
});

test("generate image route allows long-running image requests on vercel", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /export const maxDuration = 300/);
  // Functions must sit in the same region as the Tencent Cloud gateway
  // (na-siliconvalley-2). A generation makes 3-4 *sequential* gateway calls, so per-hop
  // latency dominates: ~10ms from sfo1 vs ~70ms from iad1 and ~160ms from hkg1. hkg1 is
  // closer to the user but four times further from the gateway, making it the slowest.
  assert.match(source, /export const preferredRegion = "sfo1"/);
  assert.doesNotMatch(readCode("src/app/api/generate-images/route.ts"), /preferredRegion = "hkg1"/);
  assert.match(source, /PRIMARY_UPSTREAM_TIMEOUT_MS/);
  assert.match(source, /BANANA_UPSTREAM_TIMEOUT_MS/);
  assert.match(source, /FALLBACK_UPSTREAM_TIMEOUT_MS/);
  assert.match(source, /upstreamTimeoutForEndpoint\(endpoint, modelId\)/);
  assert.match(source, /endpoint\.label === "fallback"/);
  assert.match(source, /\[image-routing\]/);
  assert.match(source, /endpointFailureReason/);
  assert.match(source, /failureReasons\.join/);
  assert.match(source, /status: 503/);
  assert.match(source, /endpoint\.label\.toLowerCase\(\)\.includes\("banana"\)/);
  assert.match(source, /AbortController/);
  assert.ok(source.indexOf("readUpstreamPayload(response)") < source.indexOf("clearTimeout(timeout)"));

  const primaryTimeout = Number(source.match(/const PRIMARY_UPSTREAM_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
  const bananaTimeout = Number(source.match(/const BANANA_UPSTREAM_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
  const fallbackTimeout = Number(source.match(/const FALLBACK_UPSTREAM_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
  assert.equal(primaryTimeout, 100_000);
  assert.equal(bananaTimeout, 100_000);
  assert.equal(fallbackTimeout, 100_000);
});

test("upstream retry budget always leaves room to refund before vercel kills the function", () => {
  const source = read("src/app/api/generate-images/route.ts");

  const maxDurationMs = Number(source.match(/export const maxDuration = (\d+)/)?.[1]) * 1000;
  const budgetMs = Number(source.match(/const UPSTREAM_BUDGET_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));
  const minAttemptMs = Number(source.match(/const MIN_ATTEMPT_BUDGET_MS = ([\d_]+)/)?.[1].replace(/_/g, ""));

  // This is the invariant that used to be violated: three 100s attempts summed to
  // exactly maxDuration, Vercel hard-killed the function, and the refund below the loop
  // never ran — so a run of upstream timeouts debited the user and returned nothing.
  assert.ok(Number.isFinite(budgetMs) && budgetMs > 0, "UPSTREAM_BUDGET_MS must be defined");
  assert.ok(budgetMs < maxDurationMs, `retry budget ${budgetMs}ms must fit inside maxDuration ${maxDurationMs}ms`);
  assert.ok(
    maxDurationMs - budgetMs >= 30_000,
    `only ${maxDurationMs - budgetMs}ms left to settle billing; need >=30000ms`,
  );
  assert.ok(minAttemptMs > 0 && minAttemptMs < budgetMs, "MIN_ATTEMPT_BUDGET_MS must be a slice of the budget");

  // Per-endpoint ceilings stay a product decision, but no single attempt may exceed the
  // shared budget, and every attempt is clamped to whatever is left of it.
  for (const [name, value] of Object.entries({
    PRIMARY_UPSTREAM_TIMEOUT_MS: Number(source.match(/const PRIMARY_UPSTREAM_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, "")),
    BANANA_UPSTREAM_TIMEOUT_MS: Number(source.match(/const BANANA_UPSTREAM_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, "")),
    FALLBACK_UPSTREAM_TIMEOUT_MS: Number(source.match(/const FALLBACK_UPSTREAM_TIMEOUT_MS = ([\d_]+)/)?.[1].replace(/_/g, "")),
  })) {
    assert.ok(value <= budgetMs, `${name}=${value}ms exceeds the ${budgetMs}ms retry budget`);
  }

  assert.match(source, /Math\.min\(upstreamTimeoutForEndpoint\(endpoint, modelId\), remainingMs\)/);
  assert.match(source, /remainingMs < MIN_ATTEMPT_BUDGET_MS/);
});

test("generate image route refunds reserved quota on every path that fails to deliver", () => {
  const source = read("src/app/api/generate-images/route.ts");

  // The refund has to be unconditional cleanup, not a statement after the loop: an
  // exhausted budget, a cancelled client, or an unexpected throw must all still refund.
  assert.match(source, /\} finally \{[\s\S]*?refundImageQuota/);
  assert.match(source, /quotaReserved = true/);
  assert.match(source, /delivered = true/);
  assert.match(source, /if \(quotaReserved && !delivered\)/);
  assert.ok(
    source.lastIndexOf("refundImageQuota") < source.lastIndexOf("All compatible image generation channels"),
    "refund must be settled before the terminal 503 is returned",
  );
});

test("generate image route remembers failing endpoints instead of re-walking a dead queue", () => {
  const source = read("src/app/api/generate-images/route.ts");
  const registry = read("src/lib/channel-registry.ts");

  // The breaker now lives in channel-registry, shared by the user and biz pipelines —
  // one pipeline's observed failure cools the endpoint for both. The route must consume
  // that shared breaker rather than keeping a private copy.
  assert.match(source, /recordEndpointFailure\(endpoint\)/);
  assert.match(source, /recordEndpointSuccess\(endpoint\)/);
  assert.match(source, /prioritizeHealthyEndpoints\(/);
  assert.match(source, /from "@\/lib\/channel-registry"/);
  assert.doesNotMatch(readCode("src/app/api/generate-images/route.ts"), /new Map<string, \{ failures/);

  assert.match(registry, /ENDPOINT_FAILURE_THRESHOLD/);
  assert.match(registry, /ENDPOINT_COOLDOWN_MS/);
  // Demoted, never removed: if every endpoint is cooling down the user must still get an
  // attempt rather than a "no endpoint configured" error.
  assert.match(registry, /\[\.\.\.healthy, \.\.\.cooling\]/);

  // The user closing the tab is not the channel's fault: a cancelled attempt must never
  // feed the breaker, or two aborted requests would bench a healthy channel for 60s.
  assert.match(source, /if \(clientCancelled\) \{/);
  assert.ok(
    source.indexOf("if (clientCancelled) {") < source.indexOf("recordEndpointFailure(endpoint);"),
    "cancellation must break out before the failure is recorded",
  );
});

test("generate image route stops billing for clients that have gone away", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /combineAbortSignals\(controller\.signal, clientSignal\)/);
  assert.match(source, /AbortSignal\.any/);
  assert.match(source, /req\.signal\?\.aborted/);
});

test("generate image route hands back a blob url rather than inlining megabytes of base64", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /canPersistGeneratedImages\(\)/);
  assert.match(source, /persistGeneratedImage\(/);
  assert.match(source, /responseImage = null/);
  assert.match(source, /image: responseImage/);
  assert.match(source, /imageUrl: responseImageUrl/);
  // Upload has to happen before the response is built, otherwise the body still carries base64.
  assert.ok(source.indexOf("persistGeneratedImage(") < source.lastIndexOf("provider: \"image_tinchak\","));
});

test("every routing exit leaves an admin-visible telemetry event", () => {
  const source = read("src/app/api/generate-images/route.ts");

  // The queue must come from the registry — the same function the /admin panel calls.
  // A route with a private queue opinion is how /admin ended up lying before.
  assert.match(source, /buildModelQueue\(modelId, process\.env/);

  // All four exits emit: empty queue, delivered, and the merged failure exit
  // (exhausted / budget-exhausted / cancelled).
  assert.match(source, /await emitRoutingEvent\("no-endpoints"\)/);
  assert.match(source, /after\(\(\) => emitRoutingEvent\("delivered", \{ deliveredBy: endpoint\.label \}\)\)/);
  assert.match(source, /await emitRoutingEvent\(failureOutcome/);

  // Failure events are written before the response: after() callbacks die with a
  // maxDuration hard-kill, and a budget-burning run is exactly the run that needs
  // evidence. Success can afford after() — the user should not wait on telemetry.
  assert.ok(
    source.indexOf("await emitRoutingEvent(failureOutcome") < source.indexOf("All compatible image generation channels"),
    "failure telemetry must be settled before the terminal 503",
  );

  // The event and the [image-routing] log line are built from the same routingQueue
  // array — they cannot disagree about what production tried.
  assert.match(source, /queue: routingQueue/);
  assert.match(source, /routingQueue\.map\(\(entry\)/);
});

test("generate image route overlaps pool loading with authentication", () => {
  const source = read("src/app/api/generate-images/route.ts");

  // Two independent round-trips; awaiting the pools after auth made them serial.
  assert.ok(source.indexOf("const poolsPromise") < source.indexOf("await authenticateImageUser"));
  assert.match(source, /poolsPromise \? await poolsPromise : \[\]/);
});

test("server history reads go through the blob sdk instead of a hand-built api url", () => {
  const source = read("src/lib/server-history-store.ts");

  // Reads once hand-built `https://blob.vercel-storage.com/<path>` — that is the API
  // host, not the public read host (`<storeId>.public.blob.vercel-storage.com`), so every
  // read 404'd: history was overwritten down to a single entry and /api/history stayed
  // empty. Only the bare API host is forbidden; matching on the public host is correct.
  assert.doesNotMatch(readCode("src/lib/server-history-store.ts"), /https:\/\/blob\.vercel-storage\.com/);
  assert.match(source, /get\(urlOrPath, \{ access: "public" \}\)/);
  assert.match(source, /statusCode !== 200/);
  assert.match(source, /export async function persistGeneratedImage/);
  assert.match(source, /export function canPersistGeneratedImages/);
});

test("admin pool store caches pools and pages through every stored config", () => {
  const source = read("src/lib/admin-pool-store.ts");

  // Read on every generation before: list() + get() per image, sixteen for copies: 8.
  assert.match(source, /POOL_CACHE_TTL_MS/);
  assert.match(source, /poolCache\.expiresAt > now/);
  assert.match(source, /export function invalidateAdminPoolCache/);
  // list() pages by pathname; ignoring hasMore meant the newest config fell off page one
  // once the prefix held more than 100 saves, silently freezing admin edits.
  assert.match(source, /page\.hasMore \? page\.cursor : undefined/);
  assert.doesNotMatch(readCode("src/lib/admin-pool-store.ts"), /limit: 100/);
  // Superseded configs were never deleted, so the prefix grew without bound.
  assert.match(source, /del\(stale\.map/);
});

test("generate image route sends SenseNova U1 Fast to its direct image endpoint", () => {
  const source = read("src/app/api/generate-images/route.ts");
  const registry = read("src/lib/channel-registry.ts");

  // Queue construction (key rotation, base URL) moved into the channel registry so the
  // admin panel can see and disable the sensenova lane; the request-body shape (n:1,
  // size mapping) stays in the route, which owns upstream protocols.
  assert.match(registry, /SENSENOVA_API_KEY/);
  assert.match(registry, /SENSENOVA_API_KEYS/);
  assert.match(registry, /https:\/\/token\.sensenova\.cn\/v1/);
  assert.match(registry, /sensenova-\$\{keyIndex \+ 1\}/);

  assert.match(source, /SENSENOVA_U1_FAST_MODEL_ID/);
  assert.match(source, /n:\s*1/);
  assert.match(source, /resolveSenseNovaImageSize\(imageSize\)/);
});

test("generate image route supports reference image edits without breaking text-only generation", () => {
  const source = read("src/app/api/generate-images/route.ts");
  const apiTypes = read("src/lib/api-types.ts");

  assert.match(apiTypes, /referenceImages\?:/);
  assert.match(apiTypes, /workflow\?: GenerationWorkflowMetadata/);
  assert.match(source, /content-type/);
  assert.match(source, /req\.formData\(\)/);
  assert.match(source, /referenceImages/);
  assert.match(source, /readWorkflowMetadata/);
  assert.match(source, /buildWorkflowPrompt/);
  assert.match(source, /schemaVersion/);
  assert.match(source, /estimatedCredits/);
  assert.match(source, /imageSize/);
  assert.match(source, /resolveImageSize/);
  assert.match(source, /workflow,/);
  assert.match(source, /form\.get\("workflow"\)/);
  assert.match(source, /\/images\/edits/);
  assert.match(source, /\/images\/generations/);
  assert.match(source, /body\.append\("image"/);
  assert.match(source, /body\.append\("size", imageSize\)/);
  assert.match(source, /size: imageSize/);
  assert.match(source, /FormData/);
  assert.ok(source.indexOf("/images/edits") < source.indexOf("/images/generations"));
});

test("Adobe 3P proxy maps aliases and uses its multimodal completion contract for reference images", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /resolveAdobe2ApiModelId/);
  assert.match(source, /resolveSupportedAspectRatio/);
  assert.match(source, /resolveSupportedResolution/);
  assert.match(source, /outputResolution/);
  assert.match(source, /endpoint\.protocol === "adobe2api"/);
  assert.match(source, /path: "\/chat\/completions"/);
  assert.match(source, /data:\$\{image\.type \|\| "image\/png"\};base64,/);
  assert.match(source, /extractAdobe2ApiImageUrl/);
  assert.match(source, /UnsupportedEndpointInputError/);
  assert.ok(
    source.indexOf("error instanceof UnsupportedEndpointInputError") < source.indexOf("recordEndpointFailure(endpoint);"),
    "unsupported Adobe 3P aspect ratios must fall through without cooling the endpoint",
  );
});

test("generate image route bills authenticated users server-side", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /authenticateImageUser/);
  assert.match(source, /reserveImageQuota/);
  assert.match(source, /refundImageQuota/);
  assert.match(source, /authenticatedUser\.id/);
  assert.ok(source.indexOf("reserveImageQuota") < source.indexOf("requestImageGeneration"));
  assert.ok(source.lastIndexOf("refundImageQuota") < source.lastIndexOf("All compatible image generation channels"));
});

test("image billing helper adjusts the server-calculated quota for each request", () => {
  const source = read("src/lib/image-billing.ts");

  assert.match(source, /export const IMAGE_GENERATION_QUOTA = QUOTA_PER_COIN/);
  assert.match(source, /requiredQuota/);
  assert.match(source, /quotaToAdjust/);
  assert.match(source, /GATEWAY_ADMIN_ACCESS_TOKEN/);
  assert.match(source, /GATEWAY_ADMIN_USER_ID/);
  assert.match(source, /\/api\/user\/manage/);
  assert.match(source, /action: "add_quota"/);
  assert.match(source, /adjustImageQuota\(userId, "subtract"/);
  assert.match(source, /adjustImageQuota\(userId, "add"/);
  assert.match(source, /\/api\/user\/\$\{userId\}/);
  assert.match(source, /user\.quota < 0/);
});

test("generate image route prices model and quality server-side", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /imageGenerationCoins/);
  assert.match(source, /qualityMode/);
  assert.match(source, /generationQuota/);
  assert.match(source, /qualityMode === "quality" \? "high" : "medium"/);
  assert.match(source, /resolveUpstreamModelId/);
});

test("generate image route reports every upstream failure after fallback attempts", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /const failureReasons: string\[\] = \[\]/);
  assert.match(source, /failureReasons\.push\(endpointFailureReason\(error\)\)/);
  assert.ok(source.indexOf("failureReasons.push") < source.lastIndexOf("NextResponse.json"));
  assert.match(source, /failureReasons\.join\("; "\)/);
  assert.match(source, /status: 503/);
});

test("generate image route logs safe upstream failure details for replenishment", () => {
  const source = read("src/app/api/generate-images/route.ts");

  assert.match(source, /class UpstreamImageError extends Error/);
  assert.match(source, /endpointHost=\$\{safeEndpointName\(endpoint\.baseURL\)\}/);
  assert.match(source, /upstreamModel=\$\{resolveUpstreamModelId\(modelId, endpoint\.modelId\)\}/);
  assert.match(source, /upstreamStatus=\$\{error\.status\}/);
  assert.doesNotMatch(source, /apiKey=.*console\.error/);
});
