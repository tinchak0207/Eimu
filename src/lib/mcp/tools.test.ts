// MCP 工具層的真實行為斷言。
//
// 驗的是三件事，全部是行為而非源碼字串：
// 1. **工具表**：≥8 條、每條 schema 合法且與驗證器同源（合法樣本通過、畸形樣本被拒）。
// 2. **執行**：未知工具回 isError（不拋 / 不 500）；參數不合 schema 拋 -32602；
//    轉發契約逐欄（路徑、方法、body 投影、Authorization 原樣透傳、traceId 進 X-Request-Id）。
// 3. **真 handler**（`src/app/api/mcp/route.ts` 直呼）：未授權一律 401（正負對照）、
//    畸型 body 回協議碼不拋 500、合法 key 才進 dispatch、憑證不回聲。

import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import { listPublicSkills, registerUserSkillSource, searchPublicSkills, type AgentSkillView } from "@/lib/agent-skills/registry";
import { JSON_RPC_ERROR_CODES, McpRpcError, type McpToolCallResult } from "./protocol";
import {
  MCP_TOOLS,
  __getToolSchemaForTests,
  callTool,
  createHttpDispatcher,
  listToolNames,
  validateToolArguments,
  type McpDispatchRequest,
  type McpDispatcher,
} from "./tools";
import { GET, POST } from "../../app/api/mcp/route";

// ─────────────────────────────────────────── 測試夾具

const VALID_KEY = `sk-biz-${"a".repeat(32)}`;
const INVALID_KEY = `sk-biz-${"b".repeat(32)}`;
const BIZ_USER_ID = 4242;
const TRACE_ID = "trace-mcp-test-0001";

type FakeDispatcher = { calls: McpDispatchRequest[]; dispatcher: McpDispatcher };

function fakeDispatcher(response: { status?: number; text?: string } = {}): FakeDispatcher {
  const calls: McpDispatchRequest[] = [];
  const dispatcher: McpDispatcher = async (request) => {
    calls.push(request);
    return {
      status: response.status ?? 200,
      contentType: "application/json",
      text: response.text ?? '{"object":"list","data":[]}',
    };
  };
  return { calls, dispatcher };
}

function ctx(dispatcher: McpDispatcher, authorization: string | null = `Bearer ${VALID_KEY}`) {
  return { authorization, traceId: TRACE_ID, dispatcher };
}

function parseResult(result: McpToolCallResult): unknown {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

/** 每條工具的「合法樣本參數」（與 inputSchema 對齊；schema 改了這裡也要改）。 */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  list_skills: { query: "電影", limit: 5 },
  get_skill: { id: "placeholder-id" },
  list_models: {},
  generate_image: {
    prompt: "一只猫",
    model: "gpt-image-2",
    size: "1536x1024",
    n: 2,
    reference_images: ["https://cdn.example/a.png"],
  },
  edit_image: { image: "https://cdn.example/a.png", prompt: "换成夜景", size: "2k", n: 1 },
  generate_video: {
    prompt: "一镜到底",
    model: "seedance-2.0",
    n: 1,
    size: "1920x1080",
    duration_seconds: 5,
    generate_audio: true,
  },
  tts: { input: "你好", voice: "female-1", model: "tts-default" },
  upscale: { image: "https://cdn.example/a.png", factor: 2, size: "1k" },
  get_quota: {},
  get_result: { kind: "video", id: "task-1" },
};

// ─────────────────────────────────────────── 1. 工具表

test("工具表：至少 8 條、名稱唯一且是 snake_case、每條都有中英雙版描述", () => {
  const tools = [...MCP_TOOLS];
  assert.ok(tools.length >= 8, `工具數 ${tools.length} 少於 8`);

  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "工具名不得重複");
  assert.deepEqual(listToolNames(), names, "listToolNames 必須與 MCP_TOOLS 同源同序");

  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} 必須是 snake_case`);
    assert.ok(tool.title.trim().length > 0, `${tool.name} 缺 title`);
    assert.match(tool.description, /[\u4e00-\u9fa5]/, `${tool.name} 描述必須有簡體中文版`);
    assert.match(tool.description, /English:/, `${tool.name} 描述必須附英文版`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} 的 inputSchema 必須是 object`);
    assert.equal(typeof tool.inputSchema.properties, "object", `${tool.name} 缺 properties`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} 必須關閉 additionalProperties`);
  }
});

test("工具表：每條工具的合法樣本都能通過自己的 inputSchema（schema 與驗證器同源）", () => {
  for (const tool of MCP_TOOLS) {
    const problem = validateToolArguments(__getToolSchemaForTests(tool.name)!, VALID_ARGS[tool.name]);
    assert.equal(problem, null, `${tool.name} 的合法樣本被拒：${problem}`);
  }
});

test("工具表：必填欄位缺一不可——空物件對有 required 的工具必須被拒", () => {
  const expectedRequired: Record<string, string> = {
    get_skill: "arguments.id",
    generate_image: "arguments.prompt",
    edit_image: "arguments.image",
    generate_video: "arguments.prompt",
    tts: "arguments.input",
    upscale: "arguments.image",
    get_result: "arguments.kind",
  };
  for (const tool of MCP_TOOLS) {
    const problem = validateToolArguments(__getToolSchemaForTests(tool.name)!, {});
    const required = expectedRequired[tool.name];
    if (required) {
      assert.ok(problem, `${tool.name} 少了必填卻驗過了`);
      assert.match(problem!, new RegExp(required.replace(".", "\\.")), `${tool.name} 錯誤訊息必須指名欄位`);
    } else {
      assert.equal(problem, null, `${tool.name} 沒有必填欄位，空物件應通過`);
    }
  }
});

test("參數驗證：型別、值域、額外欄位都要被拒（不是靜默忽略）", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["list_skills", { limit: "abc" }, /limit 必須是整數/],
    ["list_skills", { limit: 0 }, /limit 不得小於 1/],
    ["list_skills", { limit: 9999 }, /limit 不得大於 200/],
    ["list_skills", { family: "not-a-family" }, /family 只能是/],
    ["list_skills", { nope: 1 }, /nope 不是本工具支援的參數/],
    ["get_skill", { id: 42 }, /id 必須是字串/],
    ["generate_image", { prompt: "x", model: "m", n: 9 }, /n 不得大於 4/],
    ["generate_image", { prompt: "x", model: "m", size: "512x512" }, /size 只能是/],
    ["generate_image", { prompt: "x", model: "m", reference_images: "url" }, /必須是陣列/],
    ["generate_image", { prompt: "x", model: "m", reference_images: ["a", "b", "c", "d", "e", "f"] }, /最多 5 個/],
    ["upscale", { image: "u", factor: 99 }, /factor 不得大於 4/],
    ["get_result", { kind: "audio", id: "x" }, /kind 只能是/],
    ["tts", { input: "x", voice: 1 }, /voice 必須是字串/],
  ];
  for (const [name, args, pattern] of cases) {
    const problem = validateToolArguments(__getToolSchemaForTests(name)!, args);
    assert.ok(problem, `${name} 的畸形參數 ${JSON.stringify(args)} 竟驗過了`);
    assert.match(problem!, pattern, `${name} 錯誤訊息不符：${problem}`);
  }
});

// ─────────────────────────────────────────── 2. 執行層

test("未知工具：回 isError 的工具結果，不拋錯、不打上游", async () => {
  const { calls, dispatcher } = fakeDispatcher();
  const result = await callTool("no_such_tool", { any: 1 }, ctx(dispatcher));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未知工具/);
  assert.equal(calls.length, 0, "未知工具不得觸發任何轉發");
});

test("參數不合 schema：拋 McpRpcError(-32602)，且不打上游", async () => {
  const { calls, dispatcher } = fakeDispatcher();
  await assert.rejects(
    () => callTool("get_skill", {}, ctx(dispatcher)),
    (error: unknown) => {
      assert.ok(error instanceof McpRpcError);
      assert.equal((error as McpRpcError).code, JSON_RPC_ERROR_CODES.invalidParams);
      assert.match((error as McpRpcError).message, /get_skill/);
      return true;
    },
  );
  await assert.rejects(
    () => callTool("generate_image", { prompt: "x", model: "m", n: "two" }, ctx(dispatcher)),
    (error: unknown) => (error as McpRpcError).code === -32602,
  );
  assert.equal(calls.length, 0, "參數驗證失敗不得觸發轉發");
});

test("list_skills：真讀註冊表，回真子集（id 全在公開庫、無 user 來源、total 對得上）", async () => {
  const { calls, dispatcher } = fakeDispatcher();
  const registry = await listPublicSkills();
  const registryIds = new Set(registry.map((skill) => skill.id));

  const page = parseResult(await callTool("list_skills", {}, ctx(dispatcher))) as {
    total: number;
    count: number;
    families: Array<{ id: string; count: number }>;
    skills: Array<{ id: string; family: string; source: string }>;
  };

  assert.equal(page.total, registry.length, "total 必須等於公開庫全量");
  assert.ok(page.total >= 100, `公開庫應有百條以上，實得 ${page.total}`);
  assert.equal(page.count, Math.min(30, page.total), "預設 limit 30");
  for (const skill of page.skills) {
    assert.ok(registryIds.has(skill.id), `${skill.id} 不在公開庫裡`);
    assert.notEqual(skill.source, "user", "公開面不得出現 user 來源");
  }
  assert.equal(page.families.length, 10, "家族 facet 應有 10 個");
  assert.equal(
    page.families.reduce((sum, family) => sum + family.count, 0),
    registry.length,
    "家族 facet 條目數之和必須等於公開庫總量",
  );
  assert.equal(calls.length, 0, "list_skills 不得打上游 /v1");
});

test("list_skills：query 過濾是真過濾（結果集恰好等於註冊表搜尋集），family 過濾回同一家族", async () => {
  const { calls, dispatcher } = fakeDispatcher();
  const all = parseResult(await callTool("list_skills", { limit: 200 }, ctx(dispatcher))) as {
    total: number;
    skills: Array<{ id: string; family: string }>;
  };

  const query = "光";
  const searched = parseResult(await callTool("list_skills", { query, limit: 200 }, ctx(dispatcher))) as {
    total: number;
    skills: Array<{ id: string }>;
  };
  // 過濾語意的 oracle = 註冊表自己的搜尋函式（不是本檔重寫一份比對規則）
  const expectedIds = (await searchPublicSkills(query)).map((skill) => skill.id);
  assert.ok(expectedIds.length > 0, `關鍵詞 ${query} 應命中至少一條`);
  assert.ok(searched.total < all.total, "過濾後總數必須小於全量（真在過濾）");
  assert.deepEqual(
    searched.skills.map((skill) => skill.id).sort(),
    [...expectedIds].sort(),
    "工具回傳的命中集合必須與註冊表搜尋逐條一致",
  );
  assert.equal(calls.length, 0, "list_skills 不得打上游 /v1");
  assert.equal((await callTool("list_skills", { query, limit: 200 }, ctx(dispatcher))).isError, undefined);

  const family = all.skills[0].family;
  const filtered = parseResult(await callTool("list_skills", { family, limit: 200 }, ctx(dispatcher))) as {
    total: number;
    skills: Array<{ family: string }>;
  };
  const expectedFamily = (await listPublicSkills()).filter((skill) => skill.family === family).length;
  assert.equal(filtered.total, expectedFamily, "family 過濾總數必須等於該家族真實條目數");
  assert.ok(filtered.total > 0);
  for (const skill of filtered.skills) assert.equal(skill.family, family);
});

test("get_skill：真實 id 回完整條目，未知 id 回 isError", async () => {
  const { dispatcher } = fakeDispatcher();
  const registry = await listPublicSkills();
  const target = registry[0];

  const found = await callTool("get_skill", { id: target.id }, ctx(dispatcher));
  assert.notEqual(found.isError, true, `公開技能 ${target.id} 竟找不到`);
  const detail = JSON.parse(found.content[0].text) as Record<string, unknown>;
  assert.equal(detail.id, target.id);
  assert.equal(detail.source, target.source);
  assert.deepEqual(detail.toolIds, target.toolIds);
  assert.equal(detail.inputType, target.inputType);

  const missing = await callTool("get_skill", { id: "definitely-not-a-skill" }, ctx(dispatcher));
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /未找到/);
});

test("私有 skill 隔離：註冊一把私有技能後，公開面（list/get）都看不到它", async () => {
  const privateSkill: AgentSkillView = {
    id: "user-private-secret-skill",
    name: "私有测试技能",
    oneLiner: "只属于某个用户",
    family: "script",
    useScenario: "本地测试",
    inputType: "文本",
    outputContent: "文本",
    outputKind: "text",
    toolIds: [],
    tags: ["private"],
    source: "user",
  };
  registerUserSkillSource(async () => [privateSkill]);
  try {
    const { dispatcher } = fakeDispatcher();

    const listed = await callTool("list_skills", { limit: 200 }, ctx(dispatcher));
    assert.equal(listed.content[0].text.includes(privateSkill.id), false, "list_skills 洩漏了私有技能 id");
    assert.equal(listed.content[0].text.includes("私有测试技能"), false, "list_skills 洩漏了私有技能名稱");

    const searched = await callTool("list_skills", { query: "私有测试", limit: 200 }, ctx(dispatcher));
    assert.equal(searched.content[0].text.includes(privateSkill.id), false, "搜尋洩漏了私有技能");

    const direct = await callTool("get_skill", { id: privateSkill.id }, ctx(dispatcher));
    assert.equal(direct.isError, true, "get_skill 竟能取到私有技能");

    // 公開庫總量不得因為註冊了私有來源而變動
    const page = parseResult(await callTool("list_skills", {}, ctx(dispatcher))) as { total: number };
    assert.equal(page.total, (await listPublicSkills()).length);
  } finally {
    registerUserSkillSource(async () => []);
  }
});

// ─────────────────────────────────────────── 3. 轉發契約（Authorization 透傳 + traceId）

test("轉發契約：路徑/方法/body 投影/Authorization 透傳/traceId 進 X-Request-Id", async () => {
  const cases: Array<{
    tool: string;
    args: Record<string, unknown>;
    method: "GET" | "POST";
    path: string;
    expectBody?: Record<string, unknown>;
    forbiddenBodyKeys?: string[];
  }> = [
    {
      tool: "generate_image",
      args: VALID_ARGS.generate_image,
      method: "POST",
      path: "/api/v1/images/generations",
      expectBody: {
        prompt: "一只猫",
        model: "gpt-image-2",
        size: "1536x1024",
        n: 2,
        reference_images: ["https://cdn.example/a.png"],
        response_format: "url",
      },
    },
    { tool: "edit_image", args: VALID_ARGS.edit_image, method: "POST", path: "/api/v1/images/edits" },
    { tool: "generate_video", args: VALID_ARGS.generate_video, method: "POST", path: "/api/v1/videos/generations" },
    { tool: "tts", args: VALID_ARGS.tts, method: "POST", path: "/api/v1/tts/generations" },
    { tool: "upscale", args: VALID_ARGS.upscale, method: "POST", path: "/api/v1/upscale" },
    { tool: "list_models", args: {}, method: "GET", path: "/api/v1/models" },
    { tool: "get_quota", args: {}, method: "GET", path: "/api/v1/quota" },
  ];

  for (const item of cases) {
    const { calls, dispatcher } = fakeDispatcher();
    const result = await callTool(item.tool, item.args, ctx(dispatcher));
    assert.notEqual(result.isError, true, `${item.tool} 不該失敗`);
    assert.equal(calls.length, 1, `${item.tool} 應恰好轉發一次`);
    const call = calls[0];
    assert.equal(call.method, item.method, `${item.tool} 方法錯`);
    assert.equal(call.path, item.path, `${item.tool} 路徑錯`);
    assert.equal(call.authorization, `Bearer ${VALID_KEY}`, `${item.tool} 必須原樣透傳 Authorization`);
    assert.equal(call.traceId, TRACE_ID, `${item.tool} 必須帶 traceId`);
    assert.equal(call.toolName, item.tool);
    if (item.method === "GET") {
      assert.equal(call.body, undefined, `${item.tool} 是 GET，不該有 body`);
    }
    if (item.expectBody) {
      for (const [key, value] of Object.entries(item.expectBody)) {
        assert.deepEqual((call.body as Record<string, unknown>)[key], value, `${item.tool}.${key} 被改寫`);
      }
    }
  }
});

test("轉發契約：未指定 response_format 時生圖預設 url，顯式 b64_json 不得被覆蓋", async () => {
  const first = fakeDispatcher();
  await callTool("generate_image", { prompt: "x", model: "m" }, ctx(first.dispatcher));
  assert.equal((first.calls[0].body as Record<string, unknown>).response_format, "url");

  const second = fakeDispatcher();
  await callTool("generate_image", { prompt: "x", model: "m", response_format: "b64_json" }, ctx(second.dispatcher));
  assert.equal((second.calls[0].body as Record<string, unknown>).response_format, "b64_json");

  // undefined 欄位不得被塞成 null（上游按 undefined 走預設，塞 null 是語義變更）
  const third = fakeDispatcher();
  await callTool("generate_image", { prompt: "x", model: "m" }, ctx(third.dispatcher));
  assert.equal(Object.values(third.calls[0].body as object).includes(null), false);
});

test("轉發契約：get_result 依 kind 走對應端點並對 id 做 URL 編碼", async () => {
  const { calls, dispatcher } = fakeDispatcher();
  await callTool("get_result", { kind: "image", id: "img 1/2" }, ctx(dispatcher));
  await callTool("get_result", { kind: "video", id: "vid-1" }, ctx(dispatcher));
  await callTool("get_result", { kind: "tts", id: "tts-1" }, ctx(dispatcher));

  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/v1/images/img%201%2F2/result", "/api/v1/videos/vid-1/result", "/api/v1/tts/tts-1"],
  );
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("上游失敗：4xx/5xx 回 isError 並附上游原文，不是 JSON-RPC 錯誤", async () => {
  const upstreamBody = '{"error":{"message":"insufficient quota","code":"insufficient_quota"}}';
  const { dispatcher } = fakeDispatcher({ status: 402, text: upstreamBody });
  const result = await callTool("generate_image", { prompt: "x", model: "m" }, ctx(dispatcher));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 402/);
  assert.match(result.content[0].text, /insufficient_quota/, "必須讓模型看見上游原文");

  const ok = await callTool("generate_image", { prompt: "x", model: "m" }, ctx(fakeDispatcher({ status: 202, text: '{"id":"t1"}' }).dispatcher));
  assert.notEqual(ok.isError, true, "2xx 不得標成錯誤");
});

test("上游回應掺入憑證：結果必須消毒（sk-*/Bearer 一律不出網）", async () => {
  const { dispatcher } = fakeDispatcher({
    status: 200,
    text: `{"echo":"Bearer ${VALID_KEY}","key":"${VALID_KEY}"}`,
  });
  const result = await callTool("get_quota", {}, ctx(dispatcher));
  assert.equal(result.content[0].text.includes(VALID_KEY), false, "轉發結果洩漏了金鑰");
  assert.match(result.content[0].text, /REDACTED/);
});

test("轉發器拋錯（網路中斷）：收斂成 isError 的工具結果，不炸 route", async () => {
  const dispatcher: McpDispatcher = async () => {
    throw new Error(`connect ECONNREFUSED (attempted with ${VALID_KEY})`);
  };
  const result = await callTool("get_quota", {}, ctx(dispatcher));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /执行失败/);
  assert.match(result.content[0].text, /ECONNREFUSED/);
  assert.equal(result.content[0].text.includes(VALID_KEY), false, "錯誤訊息洩漏了金鑰");
});

test("createHttpDispatcher：URL/標頭/body 逐欄正確，且 GET 不帶 body", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const dispatcher = createHttpDispatcher("https://self.example.com/", fakeFetch);
  const response = await dispatcher({
    method: "POST",
    path: "/api/v1/images/generations",
    authorization: `Bearer ${VALID_KEY}`,
    traceId: TRACE_ID,
    toolName: "generate_image",
    body: { prompt: "x" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.text, '{"ok":true}');

  assert.equal(seen[0].url, "https://self.example.com/api/v1/images/generations");
  const headers = seen[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${VALID_KEY}`, "Authorization 必須原樣透傳");
  assert.equal(headers["X-Request-Id"], TRACE_ID, "traceId 進 X-Request-Id");
  assert.equal(headers["Idempotency-Key"], `mcp:generate_image:${TRACE_ID}`, "冪等鍵與 traceId 綁定");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(seen[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { prompt: "x" });

  await dispatcher({
    method: "GET",
    path: "/api/v1/quota",
    authorization: null,
    traceId: TRACE_ID,
    toolName: "get_quota",
  });
  assert.equal(seen[1].init.body, undefined, "GET 不得帶 body");
  assert.equal("Authorization" in (seen[1].init.headers as Record<string, string>), false, "沒有 Bearer 就不該憑空造一個");
});

// ─────────────────────────────────────────── 4. 真 handler（route.ts 直呼）

/** 出貨路徑的認證準備：與 `src/app/api/v1/images/generations/route.test.ts` 同法（env 兜底層）。 */
function resetAuthEnv() {
  delete process.env.GENERATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.GENERATION_CONTROL_PLANE_ENABLED;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.MCP_SELF_ORIGIN;
  process.env.BIZ_API_KEY_HASHES = `${hashBizApiKey(VALID_KEY)}:${BIZ_USER_ID}`;
  __resetBizKeyStoreForTests();
}

function mcpRequest(
  body: unknown,
  options: { auth?: string | null; method?: string; raw?: string; url?: string } = {},
) {
  const method = options.method ?? "POST";
  const headers = new Headers({ "content-type": "application/json" });
  if (options.auth) headers.set("authorization", options.auth);
  // GET/HEAD 不得帶 body（undici 會直接拋），這是協定層的限制，不是本測試的取巧。
  const carriesBody = method !== "GET" && method !== "HEAD";
  return new NextRequest(options.url ?? "http://localhost/api/mcp", {
    method,
    headers,
    ...(carriesBody ? { body: options.raw ?? JSON.stringify(body) } : {}),
  });
}

async function callMcp(body: unknown, options: { auth?: string | null; raw?: string } = {}) {
  const response = await POST(mcpRequest(body, options));
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function rpcBody(text: string): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  return JSON.parse(text) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

test.beforeEach(() => {
  resetAuthEnv();
});

test.after(() => {
  delete process.env.BIZ_API_KEY_HASHES;
  __resetBizKeyStoreForTests();
});

test("鑑權正負對照：無 Bearer → 401，形狀錯的金鑰 → 401，未登記的金鑰 → 401，登記過的金鑰 → 200", async () => {
  const noAuth = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: null });
  assert.equal(noAuth.status, 401, "未帶 Bearer 必須 401");
  assert.match(noAuth.headers.get("www-authenticate") ?? "", /Bearer/i, "401 必須帶 WWW-Authenticate: Bearer");
  assert.equal(rpcBody(noAuth.text).error!.code, -32600);
  assert.match(rpcBody(noAuth.text).error!.message, /缺少 API 密钥/);

  const malformed = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: "Bearer not-a-key" });
  assert.equal(malformed.status, 401);

  const unregistered = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: `Bearer ${INVALID_KEY}` });
  assert.equal(unregistered.status, 401);

  const valid = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: `Bearer ${VALID_KEY}` });
  assert.equal(valid.status, 200, "登記過的金鑰必須放行（正向對照）");
  assert.ok(((rpcBody(valid.text).result?.tools as unknown[]) ?? []).length >= 8);
});

test("金鑰不回聲：任何鑑權回應的 body 與標頭都不得出現 key 片段", async () => {
  for (const auth of [null, `Bearer ${INVALID_KEY}`, `Bearer ${VALID_KEY}`]) {
    const response = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth });
    const headerDump = [...response.headers.entries()].flat().join(" ");
    assert.equal(response.text.includes(VALID_KEY), false);
    assert.equal(headerDump.includes(VALID_KEY), false);
    assert.equal(response.text.includes("sk-biz-"), false, "回應不得含任何 sk-biz- 片段");
  }
});

test("401 挑戰帶 resource_metadata 指向站根發現文件（值內不得含 key 片段）", async () => {
  const response = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: null });
  assert.equal(response.status, 401);

  const challenge = response.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /, "challenge 必須是 Bearer scheme");
  assert.match(challenge, /realm="eimu-mcp"/, "既有 realm 不得被拿掉");
  assert.match(challenge, /resource_metadata="/, "必須帶 resource_metadata 參數");

  const metadata = /resource_metadata="([^"]*)"/.exec(challenge)?.[1];
  assert.ok(metadata, "resource_metadata 必須是帶引號的絕對 URL");
  assert.ok(
    metadata.endsWith("/.well-known/oauth-protected-resource"),
    `resource_metadata 必須指向站根發現文件，實得 ${metadata}`,
  );
  // 端點在 /api/mcp 之下，但發現文件在站根——不得被拼成 .../oauth-protected-resource/api/mcp
  assert.equal(metadata.includes("/api/mcp"), false, "發現文件路徑不得含端點路徑");

  // 負向對照：挑戰（含 URL 的每個字元）不得帶任何金鑰片段
  assert.equal(challenge.includes(VALID_KEY), false);
  assert.equal(challenge.includes("sk-biz-"), false);
  assert.equal(/sk-[A-Za-z0-9._-]{6,}/.test(challenge), false, "challenge 不得出現 sk-* 形態的值");
});

test("401 挑戰的 origin 跟著站點 origin 走（MCP_SELF_ORIGIN 指定時不得回請求 origin）", async () => {
  process.env.MCP_SELF_ORIGIN = "https://www.example.test/";
  try {
    const response = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: null });
    assert.equal(response.status, 401);
    const metadata = /resource_metadata="([^"]*)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1];
    assert.equal(metadata, "https://www.example.test/.well-known/oauth-protected-resource");
  } finally {
    delete process.env.MCP_SELF_ORIGIN;
  }

  // 未配置時回落本次請求的 origin（測試請求打 http://localhost/api/mcp）
  const fallback = await callMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { auth: null });
  const fallbackMetadata = /resource_metadata="([^"]*)"/.exec(
    fallback.headers.get("www-authenticate") ?? "",
  )?.[1];
  assert.equal(fallbackMetadata, "http://localhost/.well-known/oauth-protected-resource");
});

test("initialize：回聲客戶端認識的版本，不認識則回我方版本並宣告 tools 能力", async () => {
  const echo = await callMcp(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { auth: `Bearer ${VALID_KEY}` },
  );
  assert.equal(echo.status, 200);
  const echoed = rpcBody(echo.text).result as Record<string, unknown>;
  assert.equal(echoed.protocolVersion, "2024-11-05");
  assert.deepEqual(echoed.capabilities, { tools: {} });
  assert.deepEqual(echoed.serverInfo, { name: "eimu", version: "0.1.0" });

  const fallback = await callMcp(
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    { auth: `Bearer ${VALID_KEY}` },
  );
  assert.equal((rpcBody(fallback.text).result as Record<string, unknown>).protocolVersion, "2025-06-18");

  const bare = await callMcp({ jsonrpc: "2.0", id: 3, method: "initialize" }, { auth: `Bearer ${VALID_KEY}` });
  assert.equal((rpcBody(bare.text).result as Record<string, unknown>).protocolVersion, "2025-06-18");
});

test("ping / notifications / 未知方法：三個分支各走各的路", async () => {
  const ping = await callMcp({ jsonrpc: "2.0", id: 9, method: "ping" }, { auth: `Bearer ${VALID_KEY}` });
  assert.equal(ping.status, 200);
  assert.deepEqual(rpcBody(ping.text).result, {});

  const notification = await callMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { auth: `Bearer ${VALID_KEY}` });
  assert.equal(notification.status, 202, "notification 必須 202");
  assert.equal(notification.text, "", "202 不得有 body");

  const unknown = await callMcp({ jsonrpc: "2.0", id: 4, method: "not/a/method" }, { auth: `Bearer ${VALID_KEY}` });
  assert.equal(unknown.status, 200);
  assert.equal(rpcBody(unknown.text).error!.code, -32601);
});

test("畸型 body：空 body / 壞 JSON / 非 JSON-RPC / 批次陣列都不拋，各回對應協議碼", async () => {
  const auth = `Bearer ${VALID_KEY}`;

  const empty = await callMcp(null, { auth, raw: "" });
  assert.equal(empty.status, 200);
  assert.equal(rpcBody(empty.text).error!.code, -32600);

  const broken = await callMcp(null, { auth, raw: '{"jsonrpc":' });
  assert.equal(broken.status, 200);
  assert.equal(rpcBody(broken.text).error!.code, -32700, "壞 JSON 必須是 -32700");

  const notRpc = await callMcp({ hello: "world" }, { auth });
  assert.equal(rpcBody(notRpc.text).error!.code, -32600);

  const batch = await callMcp([{ jsonrpc: "2.0", id: 1, method: "ping" }], { auth });
  assert.equal(batch.status, 200);
  assert.equal(rpcBody(batch.text).error!.code, -32600, "批次請求必須明確拒絕");

  const badId = await callMcp({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" }, { auth });
  assert.equal(rpcBody(badId.text).error!.code, -32600);
});

test("tools/call：未知工具回 isError（HTTP 200，不是 500），缺 name 回 -32602", async () => {
  const auth = `Bearer ${VALID_KEY}`;

  const unknown = await callMcp(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    { auth },
  );
  assert.equal(unknown.status, 200, "未知工具不得回 5xx");
  const payload = rpcBody(unknown.text).result as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(payload.isError, true);
  assert.match(payload.content[0].text, /未知工具/);

  const missingName = await callMcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: {} }, { auth });
  assert.equal(rpcBody(missingName.text).error!.code, -32602);

  const badArgs = await callMcp(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_skill", arguments: {} } },
    { auth },
  );
  assert.equal(rpcBody(badArgs.text).error!.code, -32602, "參數驗證失敗必須是 -32602");
});

test("tools/call 正向對照：list_skills 經真 handler 回公開庫真子集", async () => {
  const response = await callMcp(
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "list_skills", arguments: { limit: 3 } } },
    { auth: `Bearer ${VALID_KEY}` },
  );
  assert.equal(response.status, 200);
  const payload = rpcBody(response.text).result as { isError?: boolean; content: Array<{ text: string }> };
  assert.notEqual(payload.isError, true);
  const data = JSON.parse(payload.content[0].text) as { total: number; skills: Array<{ id: string }> };
  const registryIds = new Set((await listPublicSkills()).map((skill) => skill.id));
  assert.equal(data.total, registryIds.size);
  assert.equal(data.skills.length, 3);
  for (const skill of data.skills) assert.ok(registryIds.has(skill.id), `${skill.id} 不在公開庫`);
});

test("GET 只回 405 + Allow: POST（本版無 SSE 通道）", async () => {
  const response = await GET(mcpRequest(null, { method: "GET" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  const body = (await response.json()) as { transport: string; allowed_methods: string[] };
  assert.equal(body.transport, "streamable-http");
  assert.deepEqual(body.allowed_methods, ["POST"]);
});
