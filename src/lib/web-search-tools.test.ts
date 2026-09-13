/**
 * web-search-tools.ts 測試（beast 軍團 R1，2026-09-10）。
 *
 * node:test + fetch mock（不真連）；覆蓋：
 *   1. 請求形狀：POST TAVILY_SEARCH_URL、body api_key/query/max_results/search_depth
 *      默認值、include_answer: true
 *   2. 缺 TAVILY_API_KEY fail-fast（人話報錯、不發請求）
 *   3. 非 2xx 錯誤帶原文 body（誠實鐵律）
 *   4. 成功解析：results（title/url/content/score）與 answer 提取、空 results 如實回
 *   5. 無效參數：缺 query、max_results 非法、max_results 收斂到帽值、search_depth 非法
 *   6. 網絡層異常與缺 results 陣列（不猜不造）
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  TAVILY_SEARCH_URL,
  TAVILY_TIMEOUT_MS,
  WEB_SEARCH_DEFAULT_MAX_RESULTS,
  WEB_SEARCH_MAX_RESULTS_CAP,
  extractTavilyResults,
  requireTavilyApiKey,
  webSearchTool,
} from "./web-search-tools.ts";

// ── fetch mock 腳手架（同構 music-lyria.test.ts） ────────────────────────────

type MockResponse = { status: number; body: string; headers?: Record<string, string> };

let mockCalls: Array<{ url: string; init: RequestInit }> = [];
let mockResponder: (url: string, init: RequestInit) => MockResponse = () => ({ status: 500, body: "no responder" });
let mockThrow: Error | null = null;

const originalFetch = globalThis.fetch;
const originalEnvKey = process.env.TAVILY_API_KEY;

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
  process.env.TAVILY_API_KEY = "test-key-123";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnvKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalEnvKey;
});

function parseOutput(result: { title: string; output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

// ── 1. 請求形狀與默認值 ──────────────────────────────────────────────────────

test("web_search: 請求形狀（POST URL、body 默認值、include_answer）", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({ results: [{ title: "t", url: "https://x", content: "c" }] }),
  }));
  const r = await webSearchTool.execute({ query: "2026 日本动漫行业趋势" });
  assert.equal(mockCalls.length, 1);
  assert.equal(mockCalls[0].url, TAVILY_SEARCH_URL);
  const body = JSON.parse(String(mockCalls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.api_key, "test-key-123");
  assert.equal(body.query, "2026 日本动漫行业趋势");
  assert.equal(body.max_results, WEB_SEARCH_DEFAULT_MAX_RESULTS);
  assert.equal(body.search_depth, "basic");
  assert.equal(body.include_answer, true);
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result_count, 1);
});

test("web_search: 顯式參數透傳、max_results 超帽收斂到 20", async () => {
  installFetchMock(() => ({ status: 200, body: JSON.stringify({ results: [] }) }));
  await webSearchTool.execute({ query: "q", max_results: 50, search_depth: "advanced" });
  const body = JSON.parse(String(mockCalls[0].init.body)) as Record<string, unknown>;
  assert.equal(body.max_results, WEB_SEARCH_MAX_RESULTS_CAP);
  assert.equal(body.search_depth, "advanced");
});

// ── 2. 缺 key fail-fast ──────────────────────────────────────────────────────

test("requireTavilyApiKey: 缺 key 人話報錯（fail-fast）", () => {
  delete process.env.TAVILY_API_KEY;
  assert.throws(() => requireTavilyApiKey(), /TAVILY_API_KEY/);
});

test("requireTavilyApiKey: 空白字串 key 視為缺失", () => {
  process.env.TAVILY_API_KEY = "   ";
  assert.throws(() => requireTavilyApiKey(), /TAVILY_API_KEY/);
});

test("web_search: 缺 key 時不發請求直接 fail（結構化，不 throw 逃逸）", async () => {
  delete process.env.TAVILY_API_KEY;
  installFetchMock(() => ({ status: 200, body: "{}" }));
  const r = await webSearchTool.execute({ query: "q" });
  assert.equal(mockCalls.length, 0);
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, false);
  const err = parsed.error as { code: string; hint: string };
  assert.equal(err.code, "missing_api_key");
  assert.match(err.hint, /TAVILY_API_KEY/);
});

// ── 3. 非 2xx 帶原文 ─────────────────────────────────────────────────────────

test("web_search: 非 2xx 帶原文 body（誠實鐵律）", async () => {
  installFetchMock(() => ({ status: 401, body: '{"detail":"Invalid API key"}' }));
  const r = await webSearchTool.execute({ query: "q" });
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, false);
  const err = parsed.error as { code: string; hint: string };
  assert.equal(err.code, "upstream_http_error");
  assert.match(err.hint, /HTTP 401/);
  assert.match(err.hint, /Invalid API key/);
});

// ── 4. 成功解析 ──────────────────────────────────────────────────────────────

test("web_search: 成功解析 results（title/url/content/score）與 answer", async () => {
  installFetchMock(() => ({
    status: 200,
    body: JSON.stringify({
      answer: "2026 年日本动漫行业呈……",
      results: [
        { title: "Anime Industry Report", url: "https://example.com/a", content: "The market grew…", score: 0.92 },
        { title: "第二條", url: "https://example.com/b", content: "内容二", score: 0.5 },
      ],
      response_time: 1.2,
    }),
  }));
  const r = await webSearchTool.execute({ query: "2026 anime industry" });
  assert.equal(r.title, "搜索完成");
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result_count, 2);
  assert.equal(parsed.answer, "2026 年日本动漫行业呈……");
  const results = parsed.results as Array<Record<string, unknown>>;
  assert.equal(results[0].title, "Anime Industry Report");
  assert.equal(results[0].url, "https://example.com/a");
  assert.equal(results[0].content, "The market grew…");
  assert.equal(results[0].score, 0.92);
  assert.equal(results[1].title, "第二條");
});

test("web_search: 空 results 如實回 result_count 0、無 answer 不偽造", async () => {
  installFetchMock(() => ({ status: 200, body: JSON.stringify({ results: [] }) }));
  const r = await webSearchTool.execute({ query: "q" });
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result_count, 0);
  assert.equal(parsed.answer, undefined);
});

// ── 5. 無效參數 ──────────────────────────────────────────────────────────────

test("web_search: 缺 query → invalid_args、不發請求", async () => {
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

// ── 6. 網絡層異常與不猜不造 ───────────────────────────────────────────────────

test("web_search: 網絡層異常 → upstream_request_failed 人話", async () => {
  installFetchMock(() => ({ status: 200, body: "{}" }));
  mockThrow = new Error("The operation was aborted due to timeout");
  const r = await webSearchTool.execute({ query: "q" });
  const parsed = parseOutput(r);
  assert.equal(parsed.ok, false);
  const err = parsed.error as { code: string; hint: string };
  assert.equal(err.code, "upstream_request_failed");
  assert.match(err.hint, new RegExp(String(TAVILY_TIMEOUT_MS)));
});

test("extractTavilyResults: 缺 results 陣列拋錯（不猜不造）", () => {
  assert.throws(() => extractTavilyResults({ foo: 1 }), /results 数组/);
});
