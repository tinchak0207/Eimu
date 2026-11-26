import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyExternalChannelDocument,
  externalChannelKeyConfigured,
  mapExternalModel,
  normalizeExternalChannel,
  normalizeExternalChannelDocument,
  resolveExternalChannelForKey,
  toPublicExternalChannel,
  type ExternalChannel,
} from "./external-channels.ts";
import {
  generateViaExternalChannel,
} from "./external-channel-adapter.ts";

const VALID = {
  id: "cust-a",
  name: "Customer A",
  baseUrl: "https://upstream.example.com",
  credentialRef: "CUST_A_API_KEY",
  modelMapping: { "gpt-image-2": "gpt-image-2-upstream" },
  apiKeyWhitelist: [],
  enabled: true,
};

test("normalizeExternalChannel accepts a valid channel and strips trailing slash", () => {
  const channel = normalizeExternalChannel({ ...VALID, baseUrl: "https://upstream.example.com/" });
  assert.ok(channel);
  assert.equal(channel.baseUrl, "https://upstream.example.com");
  assert.equal(channel.name, "Customer A");
});

test("normalizeExternalChannel rejects bad baseUrl / credentialRef / id", () => {
  assert.equal(normalizeExternalChannel({ ...VALID, baseUrl: "javascript:alert(1)" }), null);
  assert.equal(normalizeExternalChannel({ ...VALID, baseUrl: "ftp://x" }), null);
  assert.equal(normalizeExternalChannel({ ...VALID, credentialRef: "bad-name" }), null);
  assert.equal(normalizeExternalChannel({ ...VALID, id: "" }), null);
  assert.equal(normalizeExternalChannel({ ...VALID, id: "bad id!" }), null);
});

test("normalizeExternalChannel filters dirty modelMapping and whitelist entries", () => {
  const channel = normalizeExternalChannel({
    ...VALID,
    modelMapping: { "gpt-image-2": "  gpt-image-2-upstream  ", "bad key": "x", ok: 42 },
    apiKeyWhitelist: ["key-1", "", "key 2", 7],
  });
  assert.ok(channel);
  assert.deepEqual(channel.modelMapping, { "gpt-image-2": "gpt-image-2-upstream" });
  assert.deepEqual(channel.apiKeyWhitelist, ["key-1"]);
});

test("normalizeExternalChannelDocument drops invalid channels and dedupes ids", () => {
  const doc = normalizeExternalChannelDocument({
    channels: [
      VALID,
      { ...VALID, id: "ch-dup" },
      { ...VALID, id: "ch-dup" },
      { id: "broken" },
    ],
  });
  assert.deepEqual(doc.channels.map((c) => c.id), ["cust-a", "ch-dup"]);
});

test("toPublicExternalChannel never leaks the raw key, only a configured flag", () => {
  const channel = normalizeExternalChannel(VALID)!;
  const pub = toPublicExternalChannel(channel, true) as Record<string, unknown>;
  assert.equal(pub.credentialConfigured, true);
  assert.equal("apiKey" in pub, false);
  assert.equal("credentialValue" in pub, false);
  assert.deepEqual(pub.modelMapping, { "gpt-image-2": "gpt-image-2-upstream" });
});

test("resolveExternalChannelForKey returns null when no channel is enabled or matched", () => {
  const channel = normalizeExternalChannel({ ...VALID, apiKeyWhitelist: ["only-me"] })!;
  const doc = emptyExternalChannelDocument();
  doc.channels.push(channel);
  assert.equal(resolveExternalChannelForKey(doc, "other-key"), null);
  assert.equal(resolveExternalChannelForKey(doc, "only-me")?.id, "cust-a");

  const disabled = normalizeExternalChannel({ ...VALID, enabled: false })!;
  const doc2: typeof doc = { channels: [disabled] };
  assert.equal(resolveExternalChannelForKey(doc2, "any"), null);
});

test("empty whitelist means the channel applies to every key", () => {
  const channel = normalizeExternalChannel(VALID)!;
  const doc = { channels: [channel] };
  assert.equal(resolveExternalChannelForKey(doc, "any-key")?.id, "cust-a");
});

test("mapExternalModel passthrough when unmapped", () => {
  const channel = normalizeExternalChannel(VALID)!;
  assert.equal(mapExternalModel(channel, "gpt-image-2"), "gpt-image-2-upstream");
  assert.equal(mapExternalModel(channel, "nano-banana-3"), "nano-banana-3");
});

test("externalChannelKeyConfigured reflects env presence without leaking value", () => {
  const channel = normalizeExternalChannel(VALID)!;
  const env = { CUST_A_API_KEY: "secret-value" } as NodeJS.ProcessEnv;
  assert.equal(externalChannelKeyConfigured(channel, env), true);
  assert.equal(externalChannelKeyConfigured(channel, {} as NodeJS.ProcessEnv), false);
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("generateViaExternalChannel reports missing credential honestly", async () => {
  const previous = process.env.CUST_A_API_KEY;
  delete process.env.CUST_A_API_KEY;
  try {
    const channel = normalizeExternalChannel(VALID) as ExternalChannel;
    const outcome = await generateViaExternalChannel({ channel, modelId: "gpt-image-2", prompt: "x" });
    assert.equal(outcome.ok, false);
    assert.match(outcome.failures[0] ?? "", /未设定/);
  } finally {
    if (previous === undefined) delete process.env.CUST_A_API_KEY;
    else process.env.CUST_A_API_KEY = previous;
  }
});

test("generateViaExternalChannel consumes sync OpenAI data shape", async () => {
  process.env.CUST_A_API_KEY = "k";
  try {
    const channel = normalizeExternalChannel(VALID) as ExternalChannel;
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = stubFetch(async (url, init) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      return jsonResponse({ data: [{ url: "https://cdn.example.com/out.png" }] });
    });
    const outcome = await generateViaExternalChannel({ channel, modelId: "gpt-image-2", prompt: "cat", fetchImpl });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result?.imageUrl, "https://cdn.example.com/out.png");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/images\/generations$/);
    assert.match(calls[0].body ?? "", /gpt-image-2-upstream/);
  } finally {
    delete process.env.CUST_A_API_KEY;
  }
});

test("generateViaExternalChannel polls async task until succeeded", async () => {
  process.env.CUST_A_API_KEY = "k";
  try {
    const channel = normalizeExternalChannel(VALID) as ExternalChannel;
    const states = ["queued", "succeeded"];
    const fetchImpl = stubFetch(async (url) => {
      if (url.endsWith("/images/generations")) {
        return jsonResponse({ id: "task_1", status: "queued" }, 202);
      }
      return jsonResponse({
        id: "task_1",
        status: states.shift() ?? "failed",
        data: [{ b64_json: "AAAA" }],
      });
    });
    const outcome = await generateViaExternalChannel({ channel, modelId: "gpt-image-2", prompt: "cat", fetchImpl });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result?.image, "AAAA");
  } finally {
    delete process.env.CUST_A_API_KEY;
  }
});

test("generateViaExternalChannel reports failed task", async () => {
  process.env.CUST_A_API_KEY = "k";
  try {
    const channel = normalizeExternalChannel(VALID) as ExternalChannel;
    const fetchImpl = stubFetch(async (url) => {
      if (url.endsWith("/images/generations")) return jsonResponse({ id: "task_2", status: "queued" }, 202);
      return jsonResponse({ id: "task_2", status: "failed", error: { message: "boom" } });
    });
    const outcome = await generateViaExternalChannel({ channel, modelId: "gpt-image-2", prompt: "cat", fetchImpl });
    assert.equal(outcome.ok, false);
    assert.match(outcome.failures[0] ?? "", /failed/);
  } finally {
    delete process.env.CUST_A_API_KEY;
  }
});

test("generateViaExternalChannel records HTTP failure without pretending success", async () => {
  process.env.CUST_A_API_KEY = "k";
  try {
    const channel = normalizeExternalChannel(VALID) as ExternalChannel;
    const fetchImpl = stubFetch(async () => jsonResponse({ error: { message: "up" } }, 500));
    const outcome = await generateViaExternalChannel({ channel, modelId: "gpt-image-2", prompt: "cat", fetchImpl });
    assert.equal(outcome.ok, false);
    assert.match(outcome.failures[0] ?? "", /HTTP 500/);
  } finally {
    delete process.env.CUST_A_API_KEY;
  }
});

test("generateViaExternalChannel never exposes the credential in output", async () => {
  process.env.CUST_A_API_KEY = "secret-value-12345";
  try {
    const channel = normalizeExternalChannel(VALID) as ExternalChannel;
    const fetchImpl = stubFetch(async () => jsonResponse({ data: [{ url: "https://cdn.example.com/o.png" }] }));
    const outcome = await generateViaExternalChannel({ channel, modelId: "gpt-image-2", prompt: "cat", fetchImpl });
    assert.equal(outcome.ok, true);
    assert.doesNotMatch(JSON.stringify(outcome), /secret-value-12345/);
  } finally {
    delete process.env.CUST_A_API_KEY;
  }
});
