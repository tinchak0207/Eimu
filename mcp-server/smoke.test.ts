import test from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "./src/config.js";
import {
  artifactOf,
  generateAndWait,
  isJsonObject,
  pollTaskUntilDone,
  requestJson,
  safeJsonText,
  summarizeArtifacts,
  taskOf,
  toolResult,
  type FetchLike,
} from "./src/client.js";

const CONFIG = {
  apiBase: "https://image.example.com/api/v1",
  apiKey: "sk-biz-test",
  pollIntervalMs: 1,
  pollTimeoutMs: 2000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("config reads env and normalizes trailing slash", () => {
  const cfg = resolveConfig({
    IMAGE_STUDIO_API_BASE: "https://x.example/api/v1/",
    IMAGE_STUDIO_BIZ_KEY: "sk-biz-abc",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.apiBase, "https://x.example/api/v1");
  assert.equal(cfg.apiKey, "sk-biz-abc");
  assert.ok(cfg.pollIntervalMs > 0);
  assert.ok(cfg.pollTimeoutMs > 0);
});

test("missing key resolves to empty string", () => {
  const cfg = resolveConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.apiKey, "");
  assert.equal(cfg.apiBase, "https://image.tinchak0207.xyz/api/v1");
});

test("requestJson attaches Bearer auth and parses JSON", async () => {
  const fetchImpl: FetchLike = async (url, options) => {
    assert.match(String(url), /\/models$/);
    const auth = (options?.headers as Record<string, string>)?.Authorization;
    assert.equal(auth, "Bearer sk-biz-test");
    return jsonResponse({ object: "list", data: [] });
  };
  const payload = await requestJson("https://image.example.com/api/v1/models", { method: "GET" }, "sk-biz-test", fetchImpl);
  assert.deepEqual(payload, { object: "list", data: [] });
});

test("requestJson throws on non-2xx with body preview", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ error: { message: "boom" } }, 401);
  await assert.rejects(
    requestJson("https://x.example/x", { method: "GET" }, "k", fetchImpl),
    /上游 401/,
  );
});

test("taskOf rejects payloads without id", () => {
  assert.throws(() => taskOf({ status: "queued" }), /缺少 task/);
  assert.throws(() => taskOf(null), /缺少 task/);
});

test("taskOf accepts a valid task", () => {
  const task = taskOf({ object: "image_generation.task", id: "job_1", status: "queued" });
  assert.equal(task.id, "job_1");
  assert.equal(task.status, "queued");
});

test("artifactOf extracts url and b64 but hides full base64 in summary", () => {
  const artifact = { id: "a1", url: "https://cdn.example.com/1.png", b64_json: "AAAA" };
  assert.equal(artifactOf(artifact).url, "https://cdn.example.com/1.png");
  const summary = summarizeArtifacts([artifact]) as Array<Record<string, unknown>>;
  assert.equal(summary[0].url, "https://cdn.example.com/1.png");
  assert.equal(summary[0].b64_json_present, true);
  assert.equal(summary[0].b64_json_length, 4);
});

test("pollTaskUntilDone polls until succeeded", async () => {
  const states = ["queued", "queued", "succeeded"];
  const fetchImpl: FetchLike = async (url) => {
    assert.match(String(url), /\/videos\/job_9$/);
    return jsonResponse({ id: "job_9", status: states.shift() ?? "failed" });
  };
  const task = await pollTaskUntilDone("https://x.example", "k", "job_9", "videos", 1, 2000, fetchImpl);
  assert.equal(task.status, "succeeded");
});

test("pollTaskUntilDone times out on a never-terminating task", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ id: "job_t", status: "queued" });
  await assert.rejects(
    pollTaskUntilDone("https://x.example", "k", "job_t", "images", 1, 50, fetchImpl),
    /仍未終結/,
  );
});

test("generateAndWait submits then returns tool-shaped outcome with URL", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/images/generations")) {
      return jsonResponse({ id: "job_img", status: "queued" }, 202);
    }
    if (String(url).endsWith("/images/job_img")) {
      return jsonResponse({ id: "job_img", status: "succeeded", data: [{ id: "a1", url: "https://cdn.example.com/o.png" }] });
    }
    return jsonResponse({ error: { message: "not found" } }, 404);
  };
  const outcome = await generateAndWait(CONFIG, "/images/generations", { model: "gpt-image-2", prompt: "cat" }, fetchImpl);
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.url, "https://cdn.example.com/o.png");
  assert.equal(outcome.error, undefined);
  assert.equal(calls.length, 2);
  const result = toolResult(outcome);
  assert.equal(result.isError, undefined);
  assert.match(String(result.content[0].text), /cdn\.example\.com/);
});

test("generateAndWait surfaces upstream failure as error result", async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (String(url).endsWith("/images/generations")) {
      return jsonResponse({ id: "job_f", status: "failed", error: { code: "no_endpoints", message: "no capacity" } }, 202);
    }
    return jsonResponse({ id: "job_f", status: "failed", error: { code: "no_endpoints", message: "no capacity" } });
  };
  const outcome = await generateAndWait(CONFIG, "/images/generations", { model: "x", prompt: "y" }, fetchImpl);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error?.code, "no_endpoints");
  const result = toolResult(outcome);
  assert.equal(result.isError, true);
});

test("isJsonObject and safeJsonText utilities", () => {
  assert.equal(isJsonObject({ a: 1 }), true);
  assert.equal(isJsonObject([]), false);
  assert.equal(isJsonObject(null), false);
  assert.equal(safeJsonText({ a: 1 }), '{"a":1}');
});
