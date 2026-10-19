/**
 * web-search-tools.ts 测试（beast 军团 R1，2026-09-10；2026-10-02 上游 Tavily→Exa）。
 *
 * node:test + fetch mock（不真连）；覆盖：
 *   1. 请求形状：POST EXA_SEARCH_URL、header x-api-key、body 不含 api_key、
 *      contents.highlights===true、未传 max_results 时 body 不含 numResults、传了才含
 *   2. search_depth 映射：basic→auto、advanced→deep
 *   3. 缺 EXA_API_KEY fail-fast（人话报错、不发请求）
 *   4. 非 2xx 错误带原文 body（401→鉴权码、429→限流码、其他→http 码）
 *   5. 成功解析：results（title/url/highlights 原样阵列）、requestId/costDollars
 *   6. 无效参数：缺 query、max_results 非法、max_results 收敛到帽值、search_depth 非法
 *   7. 网络层逾时与缺 results 阵列（不猜不造）
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  EXA_SEARCH_URL,
  EXA_TIMEOUT_MS,
  WEB_SEARCH_DEFAULT_MAX_RESULTS,
  WEB_SEARCH_MAX_RESULTS_CAP,
  extractExaResults,
  requireExaApiKey,
  webSearchTool,
} from "./web-search-tools.ts";

// ── fetch mock 脚手架（同构 music-lyria.test.ts） ────────────────────────────

type MockResponse = { status: number; body: string; headers?: Record<string, string> };

let mockCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponder: (url: string, init: RequestInit) => MockResponse = () => ({ status: 500, body: "no responder" });
let mockThrow: Error | null = null;

const originalFetch = globalThis.fetch;
const originalEnvKey = process.env.EXA_API_KEY;

function installFetchMock(responder: (url: string, init: RequestInit) => MockResponse): void {
  mockCalls = [];
  mockThrow = null;
  mockResponder = responder;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    mockCalls.push({ url: urlStr, init: init ?? {} });
    if (mockThrow) throw mockThrow;
    const r = mockResponder(urlStr, init ?? {});
    return new Response(r.body, { status: r.status, headers: r.headers });
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.EXA_API_KEY = "test-key-123";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnvKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalEnvKey;
});

function parseOutput(result: { title: string; output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

function parsedBody(callIndex = 0): Record<string, unknown> {
  return JSON.parse(String(mockCalls[callIndex].init.body)) as Record<string, unknown>;
}

function headersOf(callIndex = 0): Record<string, string> {
  return (mockCalls[callIndex].init.headers ?? {}) as Record<string, string>;
}

// ── 1. 请求形状与默认值 ──────────────────────────────────────────────────────

test("web_search: 请求形状（POST EXA_SEARCH_URL、x-api-key header、body 不含 api_key）", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ requestId: "req-1", results: [{ title: "t", url: "https://x", highlights: ["h"] }] }),
  }));
  const r = await webSearchTool.execute({ query: "2026 日本动漫行业趋势" });
  assert.equal(mockCalls.length, 1);
  assert.equal(mockCalls[0].url, EXA_SEARCH_URL);
  assert.equal(headersOf()["x-api-key"], "test-key-123");
  const body = parsedBody();
  assert.equal(body.api_key, undefined);
  assert.equal(body.query, "2026 日本动漫行业趋势");
  assert.equal(body.type, "auto");
  assert.deepEqual(body.contents, { highlights: true });
  assert.equal(body.include_answer, undefined);
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result_count, 1);
});

test("web_search: 未传 max_results 时 body 不含 numResults 键", async () => {
  installFetchMock(() => ({ status: 200, body: JSON.stringify({ results: [] }) }));
  await webSearchTool.execute({ query: "q" });
  const body = parsedBody();
  assert.equal(Object.prototype.hasOwnProperty.call(body, "numResults"), false);
});

test("web_search: 传 max_results 才送 numResults、超帽收敛到 20", async () => {
  installFetchMock(() => ({ status: 200, body: JSON.stringify({ results: [] }) }));
  await webSearchTool.execute({ query: "q", max_results: 50, search_depth: "advanced" });
  const body = parsedBody();
  assert.equal(Object.prototype.hasOwnProperty.call(body, "numResults"), true);
  assert.equal(body.numResults, WEB_SEARCH_MAX_RESULTS_CAP);
  assert.equal(body.type, "deep");
});

test("web_search: 显式 max_results 透传（5 → numResults 5）", async () => {
  installFetchMock(() => ({ status: 200, body: JSON.stringify({ results: [] }) }));
  await webSearchTool.execute({ query: "q", max_results: 5 });
  assert.equal(parsedBody().numResults, 5);
  assert.equal(WEB_SEARCH_DEFAULT_MAX_RESULTS, 8);
});

// ── 2. search_depth 映射 ─────────────────────────────────────────────────────

test("web_search: search_depth 映射 basic→auto、advanced→deep", async () => {
  installFetchMock(() => ({ status: 200, body: JSON.stringify({ results: [] }) }));
  await webSearchTool.execute({ query: "q", search_depth: "basic" });
  assert.equal(parsedBody(0).type, "auto");
  await webSearchTool.execute({ query: "q", search_depth: "advanced" });
  assert.equal(parsedBody(1).type, "deep");
});

// ── 3. 缺 key fail-fast ──────────────────────────────────────────────────────

test("requireExaApiKey: 缺 key 人话报错（fail-fast）", () => {
  delete process.env.EXA_API_KEY;
  assert.throws(() => requireExaApiKey(), /EXA_API_KEY/);
});

test("requireExaApiKey: 空白字串 key 视为缺失", () => {
  process.env.EXA_API_KEY = "   ";
  assert.throws(() => requireExaApiKey(), /EXA_API_KEY/);
});

test("web_search: 缺 key 时不发请求直接 fail（结构化，不 throw 逃逸）", async () => {
  delete process.env.EXA_API_KEY;
  installFetchMock(() => ({ status: 200, body: "{}" }));
  const r = await webSearchTool.execute({ query: "q" });
  assert.equal(mockCalls.length, 0);
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, false);
  const err = parsed.error as { code: string; hint: string };
  assert.equal(err.code, "missing_api_key");
  assert.match(err.hint, /EXA_API_KEY/);
});

// ── 4. 非 2xx 带原文 ─────────────────────────────────────────────────────────

test("web_search: HTTP 401 → 鉴权码 upstream_auth_error 带原文", async () => {
  installFetchMock(() => ({ status: 401, body: '{"error":"invalid api key"}' }));
  const r = await webSearchTool.execute({ query: "q" });
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, false);
  const err = parsed.error as { code: string; hint: string };
  assert.equal(err.code, "upstream_auth_error");
  assert.match(err.hint, /401/);
  assert.match(err.hint, /invalid api key/);
});

test("web_search: HTTP 403 → 鉴权码 upstream_auth_error", async () => {
  installFetchMock(() => ({ status: 403, body: "forbidden" }));
  const r = await webSearchTool.execute({ query: "q" });
  assert.equal((parseOutput(r).error as { code: string }).code, "upstream_auth_error");
});

test("web_search: HTTP 429 → 限流码 upstream_rate_limited", async () => {
  installFetchMock(() => ({ status: 429, body: '{"error":"rate limit exceeded"}' }));
  const r = await webSearchTool.execute({ query: "q" });
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, false);
  const err = parsed.error as { code: string; hint: string };
  assert.equal(err.code, "upstream_rate_limited");
  assert.match(err.hint, /429/);
  assert.match(err.hint, /rate limit exceeded/);
});

test("web_search: HTTP 500 → upstream_http_error 带原文", async () => {
  installFetchMock(() => ({ status: 500, body: "boom" }));
  const r = await webSearchTool.execute({ query: "q" });
  const err = parseOutput(r).error as { code: string; hint: string };
  assert.equal(err.code, "upstream_http_error");
  assert.match(err.hint, /HTTP 500/);
  assert.match(err.hint, /boom/);
});

// ── 5. 成功解析 ──────────────────────────────────────────────────────────────

test("web_search: 成功解析 results（highlights 原样阵列）与 requestId/costDollars", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({
      requestId: "req-abc",
      results: [
        { title: "Anime Industry Report", url: "https://example.com/a", highlights: ["The market grew…", "第二段高亮"] },
        { title: "第二条", url: "https://example.com/b", highlights: [] },
      ],
      costDollars: 0.007,
      searchTime: 2.16,
    }),
  }));
  const r = await webSearchTool.execute({ query: "2026 anime industry" });
  assert.equal(r.title, "搜索完成");
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result_count, 2);
  assert.equal(parsed.requestId, "req-abc");
  assert.equal(parsed.costDollars, 0.007);
  const results = parsed.results as Array<Record<string, unknown>>;
  assert.equal(results[0].title, "Anime Industry Report");
  assert.equal(results[0].url, "https://example.com/a");
  assert.deepEqual(results[0].highlights, ["The market grew…", "第二段高亮"]);
  assert.equal(results[1].title, "第二条");
  assert.deepEqual(results[1].highlights, []);
  assert.equal(parsed.answer, undefined);
});

test("web_search: 空 results 如实回 result_count 0、不伪造 answer", async () => {
  installFetchMock(() => ({ status: 200, body: JSON.stringify({ results: [] }) }));
  const r = await webSearchTool.execute({ query: "q" });
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result_count, 0);
  assert.equal(parsed.answer, undefined);
});

test("extractExaResults: highlights 缺失时回空阵列（不臆造）", () => {
  const out = extractExaResults({ results: [{ title: "t", url: "https://x" }] });
  assert.deepEqual(out.results[0].highlights, []);
});

// ── 6. 无效参数 ──────────────────────────────────────────────────────────────

test("web_search: 缺 query → invalid_args、不发请求", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  const r = await webSearchTool.execute({});
  assert.equal(mockCalls.length, 0);
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, false);
  assert.equal((parsed.error as { code: string }).code, "invalid_args");
});

test("web_search: max_results 非法（0）→ invalid_args", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  const r = await webSearchTool.execute({ query: "q", max_results: 0 });
  assert.equal(mockCalls.length, 0);
  const parsed = parseOutput(r);
  assert.equal((parsed.error as { code: string }).code, "invalid_args");
});

test("web_search: search_depth 非法 → invalid_args", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  const r = await webSearchTool.execute({ query: "q", search_depth: "deep" });
  assert.equal(mockCalls.length, 0);
  const parsed = parseOutput(r);
  assert.equal((parsed.error as { code: string }).code, "invalid_args");
});

// ── 7. 网络层异常与不猜不造 ───────────────────────────────────────────────────

test("web_search: 网络层/逾时 → upstream_timeout 人话（带超时毫秒）", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  mockThrow = new Error("The operation was aborted due to timeout");
  const r = await webSearchTool.execute({ query: "q" });
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, false);
  const err = parsed.error as { code: string; hint: string };
  assert.equal(err.code, "upstream_timeout");
  assert.match(err.hint, new RegExp(String(EXA_TIMEOUT_MS)));
});

test("web_search: 非 JSON 响应 → upstream_bad_response（不猜不造）", async () => {
  installFetchMock(() => ({ status: 200, body: "<html>not json</html>" }));
  const r = await webSearchTool.execute({ query: "q" });
  const err = parseOutput(r).error as { code: string; hint: string };
  assert.equal(err.code, "upstream_bad_response");
  assert.match(err.hint, /合法 JSON/);
});

test("extractExaResults: 缺 results 阵列抛错（不猜不造）", () => {
  assert.throws(() => extractExaResults({ foo: 1 }), /results 数组/);
});
