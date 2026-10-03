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
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import { hashBizApiKey } from "@/lib/biz-api-keys";
import { CONTROL_PLANE_PROXY_SOURCES } from "../control-plane-proxy-routes.mjs";
import { __resetBizKeyStoreForTests } from "@/lib/biz-api-key-store";
import { listPublicSkills, registerUserSkillSource, searchPublicSkills, type AgentSkillView } from "@/lib/agent-skills/registry";
import { compileWorkflow, workflowNodeId } from "@/lib/workflow-dsl/compile";
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
  type McpToolContext,
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

function ctx(
  dispatcher: McpDispatcher,
  authorization: string | null = `Bearer ${VALID_KEY}`,
  extras: Partial<Pick<McpToolContext, "sleep" | "now">> = {},
) {
  return { authorization, traceId: TRACE_ID, dispatcher, ...extras };
}

/** `run_agent` 的測試專用 ctx：假時鐘（預設固定 0）＋ no-op sleep，永不真的等秒。 */
function agentCtx(dispatcher: McpDispatcher, now: () => number = () => 0) {
  return ctx(dispatcher, `Bearer ${VALID_KEY}`, { sleep: async () => {}, now });
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
  list_canvas_projects: {},
  canvas_get_state: { session_id: "sess-1" },
  workflow_read: { session_id: "sess-1" },
  workflow_history: { session_id: "sess-1", node_id: "wf-a" },
  workflow_write: {
    source: { workflow: "demo", steps: [{ id: "script", title: "脚本" }] },
    current: { nodes: [], connections: [] },
    label: "改成 2 步",
  },
  workflow_rollback: { node_id: "wf-a", project_id: "proj-1", version: 1 },
  list_agent_sessions: {},
  get_agent_session: { session_id: "sess-1", view: "transcript" },
  get_agent_settings: {},
  run_agent: { prompt: "画一只猫", session_id: "sess-1", timeout_seconds: 30, session_directive: "简短回复" },
  abort_agent_session: { session_id: "sess-1" },
  check_delivery_contract: {
    expert_id: "music",
    kind: "music_track",
    payload: {
      emotion_contract: "平静",
      lyrics: "la la la",
      melody_notation: "C4 D4 E4",
      audio_url: "https://cdn.example/a.mp3",
      duration_source: "measured",
      qc: "逐栏核对通过",
    },
    evidence: { url: "https://cdn.example/a.mp3" },
    qc_signature: "deadbeef",
  },
  evaluate_media_quality: { media_url: "https://cdn.example/a.mp4", policy: "video_default" },
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
    canvas_get_state: "arguments.session_id",
    workflow_read: "arguments.session_id",
    workflow_history: "arguments.session_id",
    workflow_write: "arguments.source",
    workflow_rollback: "arguments.node_id",
    get_agent_session: "arguments.session_id",
    run_agent: "arguments.prompt",
    abort_agent_session: "arguments.session_id",
    check_delivery_contract: "arguments.expert_id",
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
    // 工作流族（2026-10-03 新增）：每支的參數校驗失敗路徑
    ["list_canvas_projects", { nope: 1 }, /nope 不是本工具支援的參數/],
    ["canvas_get_state", { session_id: 1 }, /session_id 必須是字串/],
    ["canvas_get_state", { session_id: "s", nope: 1 }, /nope 不是本工具支援的參數/],
    ["workflow_read", { session_id: "s", extra: true }, /extra 不是本工具支援的參數/],
    ["workflow_history", { session_id: "s", node_id: 7 }, /node_id 必須是字串/],
    ["workflow_write", { source: "not-an-object" }, /source 必須是物件/],
    ["workflow_rollback", { node_id: "n", project_id: "p", version: 0 }, /version 不得小於 1/],
    ["workflow_rollback", { node_id: "n", project_id: "p", version: 1.5 }, /version 必須是整數/],
    // agent 族（2026-10-03 新增）
    ["list_agent_sessions", { nope: 1 }, /nope 不是本工具支援的參數/],
    ["get_agent_session", { session_id: 1 }, /session_id 必須是字串/],
    ["get_agent_session", { session_id: "s", view: "full" }, /view 只能是/],
    ["get_agent_session", { session_id: "s", nope: 1 }, /nope 不是本工具支援的參數/],
    ["get_agent_settings", { nope: 1 }, /nope 不是本工具支援的參數/],
    ["run_agent", { prompt: "x", timeout_seconds: 0 }, /timeout_seconds 不得小於 1/],
    ["run_agent", { prompt: "x", timeout_seconds: 999 }, /timeout_seconds 不得大於 300/],
    ["run_agent", { timeout_seconds: 10 }, /prompt 是必填參數/],
    ["abort_agent_session", { session_id: 1 }, /session_id 必須是字串/],
    // 閘門工具（2026-10-03 新增）
    ["check_delivery_contract", { kind: "music_track", payload: {} }, /expert_id 是必填參數/],
    ["check_delivery_contract", { expert_id: "not-an-expert", kind: "music_track", payload: {} }, /expert_id 只能是/],
    ["check_delivery_contract", { expert_id: "music", payload: {} }, /kind 是必填參數/],
    ["check_delivery_contract", { expert_id: "music", kind: "music_track", payload: [] }, /payload 必須是物件/],
    ["check_delivery_contract", { expert_id: "music", kind: "music_track", payload: {}, nope: 1 }, /nope 不是本工具支援的參數/],
    ["evaluate_media_quality", { media_url: 1 }, /media_url 必須是字串/],
    ["evaluate_media_quality", { policy: "not-a-policy" }, /policy 只能是/],
    ["evaluate_media_quality", { nope: 1 }, /nope 不是本工具支援的參數/],
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

// ─────────────────────────────────────────── 2c. 畫布專案列舉（2026-10-03 探索面）

test("list_canvas_projects：真列在工具表裡（可列舉），且轉發契約正確（GET、無 body、Authorization 原樣透傳）", async () => {
  // 可列舉斷言：工具真的進了 tools/list 的單一真源（不是只寫在發現面頁面）。
  assert.ok(listToolNames().includes("list_canvas_projects"), "listToolNames 缺 list_canvas_projects");
  assert.ok(
    MCP_TOOLS.some((tool) => tool.name === "list_canvas_projects"),
    "MCP_TOOLS 缺 list_canvas_projects",
  );
  assert.equal(
    validateToolArguments(__getToolSchemaForTests("list_canvas_projects")!, {}),
    null,
    "list_canvas_projects 無參數，空物件必須通過",
  );

  const { calls, dispatcher } = fakeDispatcher({
    text: JSON.stringify({ success: true, count: 1, projects: [{ id: "proj-1", title: "画布" }] }),
  });
  const result = await callTool("list_canvas_projects", {}, ctx(dispatcher));
  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/v1/canvas/projects");
  assert.equal(calls[0].body, undefined, "GET 不得帶 body");
  assert.equal(calls[0].authorization, `Bearer ${VALID_KEY}`, "必須原樣透傳 Authorization");

  // 上游失敗：原樣 isError 並附原文（與其他轉發工具同語義）。
  const failed = fakeDispatcher({ status: 401, text: '{"error":"missing key"}' });
  const failedResult = await callTool("list_canvas_projects", {}, ctx(failed.dispatcher));
  assert.equal(failedResult.isError, true);
  assert.match(failedResult.content[0].text, /HTTP 401/);
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

// ─────────────────────────────────────────── 2b. 工作流族（2026-10-03 MCP 暴露）

test("工作流族轉發契約：read/history 走畫布快照端點、rollback 走節點回退端點（Authorization 原樣透傳）", async () => {
  const statePayload = JSON.stringify({
    ok: true,
    has_state: true,
    updated_at: "2026-10-03T00:00:00.000Z",
    state: {
      nodes: [{ id: "wf-a" }, { id: "wf-b" }],
      connections: [],
      dsl: [{ workflow: "demo", steps: [{ id: "script" }] }],
      node_versions: [
        { node_id: "wf-a", title: "A", versions: [{ version: 1, reason: "created" }] },
        { node_id: "wf-b", title: "B", versions: [] },
      ],
    },
  });

  // 讀面：session_id 進路徑且逐段 URL 編碼
  const read = fakeDispatcher({ text: statePayload });
  await callTool("canvas_get_state", { session_id: "s 1/2" }, ctx(read.dispatcher));
  assert.equal(read.calls.length, 1);
  assert.equal(read.calls[0].method, "GET");
  assert.equal(read.calls[0].path, "/api/agent/biz/sessions/s%201%2F2/canvas/state");
  assert.equal(read.calls[0].authorization, `Bearer ${VALID_KEY}`, "必須原樣透傳 Authorization");
  assert.equal(read.calls[0].body, undefined, "GET 不得帶 body");

  // 回滾面：node_id 進路徑、projectId/version 進 body
  const rollback = fakeDispatcher({ text: '{"success":true}' });
  await callTool("workflow_rollback", { node_id: "wf-a", project_id: "proj-1", version: 2 }, ctx(rollback.dispatcher));
  assert.equal(rollback.calls[0].method, "POST");
  assert.equal(rollback.calls[0].path, "/api/v1/canvas/nodes/wf-a/revert");
  assert.deepEqual(rollback.calls[0].body, { projectId: "proj-1", version: 2 });

  // 省略 version：body 不得塞 null（上游據 undefined 走「上一版」語義）
  const rollbackPrev = fakeDispatcher({ text: '{"success":true}' });
  await callTool("workflow_rollback", { node_id: "wf-a", project_id: "proj-1" }, ctx(rollbackPrev.dispatcher));
  assert.deepEqual(rollbackPrev.calls[0].body, { projectId: "proj-1" });
});

test("workflow_read / workflow_history：只投影 dsl 與版本索引（非原文照抄），node_id 是真過濾", async () => {
  const statePayload = JSON.stringify({
    ok: true,
    has_state: true,
    updated_at: "2026-10-03T00:00:00.000Z",
    state: {
      nodes: [{ id: "wf-a" }, { id: "wf-b" }],
      connections: [],
      dsl: [{ workflow: "demo", steps: [{ id: "script" }] }],
      node_versions: [
        { node_id: "wf-a", title: "A", versions: [{ version: 1, reason: "created" }] },
        { node_id: "wf-b", title: "B", versions: [] },
      ],
    },
  });

  const read = parseResult(
    await callTool("workflow_read", { session_id: "sess-1" }, ctx(fakeDispatcher({ text: statePayload }).dispatcher)),
  ) as { has_state: boolean; dsl: unknown[]; workflow_versions: Array<{ node_id: string }>; nodes?: unknown };
  assert.equal(read.has_state, true);
  assert.equal(read.dsl.length, 1);
  assert.equal(read.dsl[0] && (read.dsl[0] as { workflow: string }).workflow, "demo");
  assert.deepEqual(read.workflow_versions.map((e) => e.node_id), ["wf-a", "wf-b"]);
  assert.equal("nodes" in read, false, "讀面不得回節點座標（那是 canvas_get_state 的職責）");

  const filtered = parseResult(
    await callTool("workflow_history", { session_id: "sess-1", node_id: "wf-b" }, ctx(fakeDispatcher({ text: statePayload }).dispatcher)),
  ) as { node_id: string; workflow_versions: Array<{ node_id: string }> };
  assert.equal(filtered.node_id, "wf-b");
  assert.deepEqual(filtered.workflow_versions.map((e) => e.node_id), ["wf-b"]);
});

test("workflow_read：上游無快照（has_state=false）原樣投影，不假裝有內容", async () => {
  const empty = JSON.stringify({ ok: true, has_state: false, state: null, updated_at: null });
  const read = parseResult(
    await callTool("workflow_read", { session_id: "sess-x" }, ctx(fakeDispatcher({ text: empty }).dispatcher)),
  ) as { has_state: boolean; dsl: unknown[]; workflow_versions: unknown[] };
  assert.equal(read.has_state, false);
  assert.deepEqual(read.dsl, []);
  assert.deepEqual(read.workflow_versions, []);
});

test("workflow_write 真行為：參數餵給真編譯器，回傳 ops 帶確定性 wf- 節點 id（不是 schema 探針）", async () => {
  const seen: McpDispatchRequest[] = [];
  // 注入的 dispatcher 直接呼叫真實現 compileWorkflow（= /v1/workflow/compile 的核心），
  // 讓斷言來自被測實現之外的真源（編譯器本身），而非 tools.ts 的輸出字串。
  const dispatcher: McpDispatcher = async (request) => {
    seen.push(request);
    const body = (request.body ?? {}) as { source?: unknown; current?: { nodes?: unknown[]; connections?: unknown[] }; label?: unknown };
    const result = compileWorkflow(body.source as never, {
      nodes: (body.current?.nodes ?? []) as never,
      connections: (body.current?.connections ?? []) as never,
    });
    if (!result.ok) {
      return {
        status: 422,
        contentType: "application/json",
        text: JSON.stringify({ success: false, code: "workflow_dsl_invalid", errors: result.errors }),
      };
    }
    return {
      status: 200,
      contentType: "application/json",
      text: JSON.stringify({ success: true, ops: result.ops, summary: result.summary, label: body.label ?? null }),
    };
  };

  const source = {
    workflow: "demo",
    title: "两步产线",
    steps: [
      { id: "script", title: "脚本", kind: "text", prompt: "写一个三幕短片大纲" },
      { id: "shot1", title: "镜头一", needs: ["script"], prompt: "夕阳海面", size: "1024x1024" },
    ],
  };
  const result = await callTool("workflow_write", { source, label: "起两条" }, ctx(dispatcher));
  assert.notEqual(result.isError, true, result.content[0].text);

  const payload = JSON.parse(result.content[0].text) as {
    success: boolean;
    ops: Array<Record<string, unknown>>;
    summary: { added: number };
  };
  assert.equal(payload.success, true);
  const nodeIds = payload.ops
    .filter((op) => op.type === "add_node")
    .map((op) => (op.node as Record<string, unknown>).id as string);
  // oracle = 編譯器自己的確定性 id 函式（獨立於 tools.ts）
  assert.ok(nodeIds.includes(workflowNodeId("demo", "script")), `ops 缺 script 節點：${JSON.stringify(nodeIds)}`);
  assert.ok(nodeIds.includes(workflowNodeId("demo", "shot1")), `ops 缺 shot1 節點：${JSON.stringify(nodeIds)}`);
  assert.ok(payload.summary.added >= 2, `summary.added=${payload.summary.added}`);
  assert.ok(payload.ops.some((op) => op.type === "connect_nodes"), "needs 應編出連線");

  // 轉發契約：真打純編譯端點、source 原樣透傳、label 帶上
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].path, "/api/v1/workflow/compile");
  assert.deepEqual((seen[0].body as Record<string, unknown>).source, source);
  assert.equal((seen[0].body as Record<string, unknown>).label, "起两条");
});

test("workflow_write 帶 project_id 時改走落圖端點（參數映射成 projectId，不帶則維持純編譯端點）", async () => {
  const compileOnly = fakeDispatcher({ text: '{"success":true,"ops":[],"summary":{}}' });
  await callTool("workflow_write", { source: { workflow: "demo", steps: [{ id: "a", title: "A" }] } }, ctx(compileOnly.dispatcher));
  assert.equal(compileOnly.calls[0].path, "/api/v1/workflow/compile");
  assert.deepEqual(compileOnly.calls[0].body, { source: { workflow: "demo", steps: [{ id: "a", title: "A" }] } });

  const apply = fakeDispatcher({ text: '{"success":true,"applied":2,"projectId":"proj-1"}' });
  await callTool(
    "workflow_write",
    { source: { workflow: "demo", steps: [{ id: "a", title: "A" }] }, project_id: "proj-1", label: "改成一步" },
    ctx(apply.dispatcher),
  );
  assert.equal(apply.calls[0].method, "POST");
  assert.equal(apply.calls[0].path, "/api/v1/canvas/workflow");
  assert.deepEqual(apply.calls[0].body, {
    projectId: "proj-1",
    source: { workflow: "demo", steps: [{ id: "a", title: "A" }] },
    label: "改成一步",
  });
  assert.equal(apply.calls[0].authorization, `Bearer ${VALID_KEY}`, "落圖呼叫同樣原樣透傳 Authorization");
});

test("workflow_write：DSL 非法時上游 422 原樣透傳 errors（isError，畫布不動）", async () => {
  const dispatcher: McpDispatcher = async (request) => {
    const body = (request.body ?? {}) as { source?: unknown };
    const result = compileWorkflow(body.source as never, { nodes: [], connections: [] });
    return {
      status: result.ok ? 200 : 422,
      contentType: "application/json",
      text: JSON.stringify(
        result.ok
          ? { success: true, ops: result.ops, summary: result.summary }
          : { success: false, code: "workflow_dsl_invalid", errors: result.errors },
      ),
    };
  };
  // 空 steps 必然校驗失敗（steps 1..24）
  const result = await callTool("workflow_write", { source: { workflow: "demo", steps: [] } }, ctx(dispatcher));
  assert.equal(result.isError, true, "非法 DSL 必須標成工具錯誤");
  assert.match(result.content[0].text, /HTTP 422/);
  assert.match(result.content[0].text, /workflow_dsl_invalid/);
});

// ─────────────────────────────────────────── 2d. Eimu agent 閘道族（2026-10-03 MCP 暴露）
//
// 這條線＝B 端密鑰 → `/api/agent/biz/**` 站內代理 → VPS 閘道 `/agent/v1/**`（與網頁版 AI 助理
// 同一身分空間）。全部用假 dispatcher 斷言真行為（路徑/方法/呼叫序列/產物抽取），不打真端點。

const AGENT_OLD_MESSAGES = [
  { role: "user", text: "旧问题" },
  { role: "assistant", text: "旧答" },
  { role: "system", text: "sys" },
  { role: "user", text: "旧问题二" },
];

function jsonResponse(payload: unknown, status = 200) {
  return { status, contentType: "application/json", text: JSON.stringify(payload) };
}

/** 依 `"METHOD /path"` 腳本化的 dispatcher；未預期路徑直接拋錯（防假通過）。 */
function scriptedDispatcher(
  routes: Record<string, () => { status?: number; contentType?: string; text?: string }>,
): { calls: McpDispatchRequest[]; dispatcher: McpDispatcher } {
  const calls: McpDispatchRequest[] = [];
  const dispatcher: McpDispatcher = async (request) => {
    calls.push(request);
    const handler = routes[`${request.method} ${request.path}`];
    assert.ok(handler, `未預期的轉發：${request.method} ${request.path}`);
    const response = handler!();
    return {
      status: response.status ?? 200,
      contentType: response.contentType ?? "application/json",
      text: response.text ?? "{}",
    };
  };
  return { calls, dispatcher };
}

test("agent 讀面：list_agent_sessions / get_agent_settings 打對端點（GET、Authorization 原樣透傳、清單欄位投影）", async () => {
  const list = fakeDispatcher({
    text: JSON.stringify({
      object: "agent.session.list",
      sessions: [
        {
          session_id: "sess-1",
          status: "idle",
          title: "标题",
          updated_at: "2026-10-03T00:00:00Z",
          created_at: "2026-10-02T00:00:00Z",
          secret_field: "不应出现",
        },
      ],
    }),
  });
  const listed = parseResult(await callTool("list_agent_sessions", {}, ctx(list.dispatcher))) as {
    object: string;
    count: number;
    sessions: Array<Record<string, unknown>>;
  };
  assert.equal(list.calls.length, 1);
  assert.equal(list.calls[0].method, "GET");
  assert.equal(list.calls[0].path, "/api/agent/biz/sessions");
  assert.equal(list.calls[0].body, undefined, "GET 不得帶 body");
  assert.equal(list.calls[0].authorization, `Bearer ${VALID_KEY}`, "必須原樣透傳 Authorization");
  assert.equal(listed.object, "agent.session.list");
  assert.equal(listed.count, 1);
  assert.deepEqual(
    listed.sessions,
    [{ session_id: "sess-1", status: "idle", title: "标题", updated_at: "2026-10-03T00:00:00Z" }],
    "清單只投影 session_id/status/title/updated_at",
  );

  const settings = fakeDispatcher({
    text: JSON.stringify({
      interrupt_mode: "steer",
      persona: "efficient",
      cost_mode: "balanced",
      interaction_mode: "preset",
      beast_mode: true,
    }),
  });
  const settingsResult = parseResult(await callTool("get_agent_settings", {}, ctx(settings.dispatcher))) as {
    beast_mode: boolean;
  };
  assert.equal(settings.calls.length, 1);
  assert.equal(settings.calls[0].method, "GET");
  assert.equal(settings.calls[0].path, "/api/agent/biz/settings");
  assert.equal(settings.calls[0].authorization, `Bearer ${VALID_KEY}`);
  assert.equal(settingsResult.beast_mode, true);
});

test("get_agent_session：三種 view 各打對子路徑（session_id 逐段 URL 編碼、皆 GET 帶 Authorization）", async () => {
  const summary = fakeDispatcher({ text: JSON.stringify({ session_id: "s", message_count: 2, messages: [] }) });
  await callTool("get_agent_session", { session_id: "s 1/2" }, ctx(summary.dispatcher));
  const transcript = fakeDispatcher({ text: JSON.stringify({ messages: [] }) });
  await callTool("get_agent_session", { session_id: "s 1/2", view: "transcript" }, ctx(transcript.dispatcher));
  const raw = fakeDispatcher({ text: JSON.stringify({ messages: [], event_counter: 3 }) });
  await callTool("get_agent_session", { session_id: "s 1/2", view: "raw" }, ctx(raw.dispatcher));

  assert.deepEqual(
    [summary.calls[0], transcript.calls[0], raw.calls[0]].map((call) => `${call.method} ${call.path}`),
    [
      "GET /api/agent/biz/sessions/s%201%2F2",
      "GET /api/agent/biz/sessions/s%201%2F2/transcript",
      "GET /api/agent/biz/sessions/s%201%2F2/messages",
    ],
  );
  for (const call of [summary.calls[0], transcript.calls[0], raw.calls[0]]) {
    assert.equal(call.method, "GET");
    assert.equal(call.authorization, `Bearer ${VALID_KEY}`);
    assert.equal(call.toolName, "get_agent_session");
  }
});

test("run_agent：無 session_id 時先建會話→取基線→送訊息→輪詢（第一輪未完成、第二輪完成，斷言呼叫序列）", async () => {
  let detailHits = 0;
  const { calls, dispatcher } = scriptedDispatcher({
    "POST /api/agent/biz/sessions": () => jsonResponse({ object: "agent.session", session_id: "sess-new", unknown_field: 1 }),
    "GET /api/agent/biz/sessions/sess-new": () => {
      detailHits += 1;
      if (detailHits === 1) return jsonResponse({ message_count: 4, messages: AGENT_OLD_MESSAGES });
      if (detailHits === 2) {
        // 輪詢第一輪：只有我們送出的使用者訊息，尚無 assistant 文字 ⇒ 未完成
        return jsonResponse({ message_count: 5, messages: [...AGENT_OLD_MESSAGES, { role: "user", text: "画猫" }] });
      }
      // 輪詢第二輪：出現新 assistant 文字 ⇒ 完成
      return jsonResponse({
        message_count: 6,
        messages: [
          ...AGENT_OLD_MESSAGES,
          { role: "user", text: "画猫" },
          { role: "assistant", text: "画好了 https://cdn.test/image-data/files/a.webp", created_at: "t2" },
        ],
      });
    },
    "POST /api/agent/biz/sessions/sess-new/messages": () => ({ status: 202, contentType: "application/json", text: "" }),
  });

  const result = await callTool("run_agent", { prompt: "画猫" }, agentCtx(dispatcher));
  assert.notEqual(result.isError, true, result.content[0].text);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "POST /api/agent/biz/sessions",
      "GET /api/agent/biz/sessions/sess-new",
      "POST /api/agent/biz/sessions/sess-new/messages",
      "GET /api/agent/biz/sessions/sess-new",
      "GET /api/agent/biz/sessions/sess-new",
    ],
    "呼叫序列必須是 建會話→基線→送訊息→輪詢×2（證明輪詢存在）",
  );
  assert.deepEqual(calls[0].body, {}, "建立會話 body 必須是空物件");
  assert.deepEqual(calls[2].body, { content: "画猫" }, "送訊息只帶 content");
  assert.ok(calls.every((call) => call.authorization === `Bearer ${VALID_KEY}`), "每一跳都必須帶 Authorization");

  const payload = parseResult(result) as {
    session_id: string;
    status: string;
    reply: string;
    artifacts: Array<{ url: string; kind: string }>;
    messages: Array<{ role: string }>;
  };
  assert.equal(payload.session_id, "sess-new");
  assert.equal(payload.status, "completed");
  assert.equal(payload.reply, "画好了 https://cdn.test/image-data/files/a.webp", "取基線之後最後一則 assistant 文字");
  assert.deepEqual(payload.artifacts, [{ url: "https://cdn.test/image-data/files/a.webp", kind: "image" }]);
  assert.deepEqual(payload.messages.map((message) => message.role), ["user", "assistant"]);
});

test("run_agent：帶 session_id 時不建會話（第一跳是基線讀取，且無 POST /sessions）", async () => {
  const calls: McpDispatchRequest[] = [];
  let detailHits = 0;
  const dispatcher: McpDispatcher = async (request) => {
    calls.push(request);
    if (request.method === "POST" && request.path === "/api/agent/biz/sessions/sess-x/messages") {
      return { status: 200, contentType: "application/json", text: '{"accepted":true}' };
    }
    if (request.method === "GET" && request.path === "/api/agent/biz/sessions/sess-x") {
      detailHits += 1;
      if (detailHits === 1) return jsonResponse({ message_count: 0, messages: [] });
      return jsonResponse({
        message_count: 2,
        messages: [
          { role: "user", text: "hi" },
          { role: "assistant", text: "你好" },
        ],
      });
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  };

  const result = await callTool("run_agent", { prompt: "hi", session_id: "sess-x", timeout_seconds: 30 }, agentCtx(dispatcher));
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(
    calls.some((call) => call.method === "POST" && call.path === "/api/agent/biz/sessions"),
    false,
    "帶了 session_id 就不該再建會話",
  );
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, "/api/agent/biz/sessions/sess-x", "第一跳必須是基線讀取");
  const payload = parseResult(result) as { session_id: string; status: string; reply: string };
  assert.equal(payload.session_id, "sess-x");
  assert.equal(payload.status, "completed");
  assert.equal(payload.reply, "你好");
});

test("run_agent：artifacts 抽出圖片與影片 URL（kind 正確），原文 reply 完整保留", async () => {
  const reply = [
    "已完成！",
    "![预览](https://cdn.test/image-data/files/pic.webp)",
    "视频：https://cdn.test/image-data/files/clip.mp4",
    "文档：https://cdn.test/docs/readme.txt",
    "扩展名带查询串：https://cdn.test/image-data/files/raw.png?x=1",
  ].join("\n");
  let detailHits = 0;
  const dispatcher: McpDispatcher = async (request) => {
    if (request.method === "POST" && request.path === "/api/agent/biz/sessions/sess-a/messages") {
      return { status: 202, contentType: "application/json", text: "" };
    }
    if (request.method === "GET" && request.path === "/api/agent/biz/sessions/sess-a") {
      detailHits += 1;
      if (detailHits === 1) return jsonResponse({ message_count: 0, messages: [] });
      return jsonResponse({
        message_count: 2,
        messages: [
          { role: "user", text: "hi" },
          { role: "assistant", text: reply },
        ],
      });
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  };

  const result = await callTool("run_agent", { prompt: "hi", session_id: "sess-a" }, agentCtx(dispatcher));
  const payload = parseResult(result) as { status: string; reply: string; artifacts: Array<{ url: string; kind: string }> };
  assert.equal(payload.status, "completed");
  assert.equal(payload.reply, reply, "reply 必須保留原文，不得只回 URL");
  assert.deepEqual(payload.artifacts, [
    { url: "https://cdn.test/image-data/files/pic.webp", kind: "image" },
    { url: "https://cdn.test/image-data/files/clip.mp4", kind: "video" },
    { url: "https://cdn.test/image-data/files/raw.png?x=1", kind: "image" },
  ]);
});

test("run_agent：逾時回 status=running 且不拋錯（附 get_agent_session 續查提示）", async () => {
  const calls: McpDispatchRequest[] = [];
  const dispatcher: McpDispatcher = async (request) => {
    calls.push(request);
    if (request.method === "POST" && request.path === "/api/agent/biz/sessions/sess-t/messages") {
      return { status: 202, contentType: "application/json", text: "" };
    }
    if (request.method === "GET" && request.path === "/api/agent/biz/sessions/sess-t") {
      // 永遠只有使用者訊息，沒有 assistant 文字 ⇒ 永遠不完成
      return jsonResponse({ message_count: 1, messages: [{ role: "user", text: "hi" }] });
    }
    throw new Error(`unexpected ${request.method} ${request.path}`);
  };
  let tick = 0;
  const now = () => (tick += 100_000);
  const result = await callTool("run_agent", { prompt: "hi", session_id: "sess-t", timeout_seconds: 5 }, agentCtx(dispatcher, now));

  assert.notEqual(result.isError, true, "逾時不得是工具錯誤");
  const payload = parseResult(result) as {
    session_id: string;
    status: string;
    reply: string;
    artifacts: unknown[];
    hint: string;
  };
  assert.equal(payload.status, "running");
  assert.equal(payload.session_id, "sess-t");
  assert.equal(typeof payload.reply, "string", "逾時仍回目前最後一則回覆（可為空字串）");
  assert.deepEqual(payload.artifacts, []);
  assert.match(payload.hint, /get_agent_session/, "必須告訴呼叫方可用 get_agent_session 續查");
  assert.ok(calls.length >= 3, "必須真的走過 基線＋送訊息＋至少一輪輪詢");
});

test("abort_agent_session：POST 到 abort 路徑、body 為空物件、上游回包原樣", async () => {
  const abort = fakeDispatcher({ text: '{"object":"agent.session.aborted","ok":true}' });
  const result = await callTool("abort_agent_session", { session_id: "s 1/2" }, ctx(abort.dispatcher));
  assert.notEqual(result.isError, true);
  assert.equal(abort.calls.length, 1);
  assert.equal(abort.calls[0].method, "POST");
  assert.equal(abort.calls[0].path, "/api/agent/biz/sessions/s%201%2F2/abort");
  assert.deepEqual(abort.calls[0].body, {}, "abort body 必須是空物件");
  assert.equal(abort.calls[0].authorization, `Bearer ${VALID_KEY}`);
  assert.deepEqual(parseResult(result), { object: "agent.session.aborted", ok: true });
});

test("agent 族：五個工具都在單一真源裡（可列舉）", () => {
  for (const name of [
    "list_agent_sessions",
    "get_agent_session",
    "get_agent_settings",
    "run_agent",
    "abort_agent_session",
  ]) {
    assert.ok(listToolNames().includes(name), `listToolNames 缺 ${name}`);
    assert.ok(
      MCP_TOOLS.some((tool) => tool.name === name),
      `MCP_TOOLS 缺 ${name}`,
    );
  }
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

/**
 * 攔截全域 fetch，記錄真發出的 URL 與 init（**真行為斷言**，不是源碼字串掃描）。
 * route.ts 的 dispatcher 用預設 fetchImpl＝呼叫當下的全域 fetch，故在此換掉即可。
 */
function stubFetch(): { calls: Array<{ url: string; init: RequestInit }>; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function clearDispatchEnv() {
  delete process.env.MCP_DISPATCH_ORIGIN;
  delete process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN;
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
  // 能力面自 2026-10-03 起除 tools 外還宣告 resources / prompts（harness 指南與模板；
  // 對應 route.ts 的 resources/list、prompts/list）。仍是逐項精確比對，不是弱化。
  assert.deepEqual(echoed.capabilities, { tools: {}, resources: {}, prompts: {} });
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

// ─────────────────────────────────────────── 5. 轉發 origin 拆分（2026-10-03 CF 403）

test("轉發 origin：get_quota 走不掛 CF 的控制面 origin（真 fetch URL、Authorization 逐字透傳）", async () => {
  clearDispatchEnv();
  // 尾斜線刻意留著：驗 resolve 時的 trim/去尾斜線。
  process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = "https://store.tinchak0207.xyz/";
  const { calls, restore } = stubFetch();
  try {
    const response = await callMcp(
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "get_quota", arguments: {} } },
      { auth: `Bearer ${VALID_KEY}` },
    );
    assert.equal(response.status, 200);
    const payload = rpcBody(response.text).result as { isError?: boolean; content: Array<{ text: string }> };
    assert.notEqual(payload.isError, true, payload.content[0].text);

    assert.equal(calls.length, 1, "get_quota 應恰好轉發一次");
    assert.equal(calls[0].url, "https://store.tinchak0207.xyz/image-control/api/v1/quota");
    assert.equal(calls[0].init.method, "GET");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${VALID_KEY}`, "Authorization 必須逐字透傳");
    assert.ok(headers["Idempotency-Key"], "必須帶 MCP 冪等鍵");
  } finally {
    restore();
    clearDispatchEnv();
  }
});

test("轉發 origin：非控制面路徑（canvas_get_state）回落公開 origin", async () => {
  clearDispatchEnv();
  const { calls, restore } = stubFetch();
  try {
    const response = await callMcp(
      { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "canvas_get_state", arguments: { session_id: "s1" } } },
      { auth: `Bearer ${VALID_KEY}` },
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://localhost/api/agent/biz/sessions/s1/canvas/state");
  } finally {
    restore();
    clearDispatchEnv();
  }
});

test("轉發 origin：MCP_DISPATCH_ORIGIN 覆寫一切（控制面路徑與回落路徑都改道）", async () => {
  clearDispatchEnv();
  process.env.MCP_DISPATCH_ORIGIN = "https://dispatch.example/";
  process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = "https://store.tinchak0207.xyz";
  const { calls, restore } = stubFetch();
  try {
    await callMcp(
      { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "get_quota", arguments: {} } },
      { auth: `Bearer ${VALID_KEY}` },
    );
    await callMcp(
      { jsonrpc: "2.0", id: 24, method: "tools/call", params: { name: "canvas_get_state", arguments: { session_id: "s1" } } },
      { auth: `Bearer ${VALID_KEY}` },
    );
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        "https://dispatch.example/api/v1/quota",
        "https://dispatch.example/api/agent/biz/sessions/s1/canvas/state",
      ],
    );
  } finally {
    restore();
    clearDispatchEnv();
  }
});

test("轉發 origin：未配置控制面 origin 時 get_quota 回落公開 origin（回歸保護）", async () => {
  clearDispatchEnv();
  const { calls, restore } = stubFetch();
  try {
    await callMcp(
      { jsonrpc: "2.0", id: 25, method: "tools/call", params: { name: "get_quota", arguments: {} } },
      { auth: `Bearer ${VALID_KEY}` },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://localhost/api/v1/quota");
  } finally {
    restore();
    clearDispatchEnv();
  }
});

test("GET 只回 405 + Allow: POST（本版無 SSE 通道）", async () => {
  const response = await GET(mcpRequest(null, { method: "GET" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  const body = (await response.json()) as { transport: string; allowed_methods: string[] };
  assert.equal(body.transport, "streamable-http");
  assert.deepEqual(body.allowed_methods, ["POST"]);
});

// ─────────────────────────────────────────── 6. 閘門工具（2026-10-03 交付契約＋媒體硬檢）

test("check_delivery_contract：POST 到交付契約端點、body 原樣帶 snake_case、回包原樣", async () => {
  // 可列舉斷言：真的進了 tools/list 的單一真源。
  assert.ok(listToolNames().includes("check_delivery_contract"), "listToolNames 缺 check_delivery_contract");
  assert.ok(
    MCP_TOOLS.some((tool) => tool.name === "check_delivery_contract"),
    "MCP_TOOLS 缺 check_delivery_contract",
  );

  const upstream = JSON.stringify({
    ok: false,
    errors: ["qcSignature 與交付物內容不符（签名被篡改或计算口径不一致）：请用 computeQcSignature 对 expertId/kind/payload 原文重算后重交。"],
    qc_signature: "cafebabe",
  });
  const args = {
    expert_id: "music",
    kind: "music_track",
    payload: { audio_url: "https://cdn.example/a.mp3", qc: "逐栏核对通过" },
    evidence: { url: "https://cdn.example/a.mp3" },
    qc_signature: "deadbeef",
  };
  const { calls, dispatcher } = fakeDispatcher({ text: upstream });
  const result = await callTool("check_delivery_contract", args, ctx(dispatcher));

  assert.notEqual(result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/harness/expert/deliverable/validate");
  assert.equal(calls[0].authorization, `Bearer ${VALID_KEY}`, "必須原樣透傳 Authorization");
  assert.equal(calls[0].traceId, TRACE_ID);
  assert.deepEqual(
    calls[0].body,
    {
      expert_id: "music",
      kind: "music_track",
      payload: { audio_url: "https://cdn.example/a.mp3", qc: "逐栏核对通过" },
      evidence: { url: "https://cdn.example/a.mp3" },
      qc_signature: "deadbeef",
    },
    "body 必須原樣帶 snake_case（expert_id/kind/payload/evidence/qc_signature）",
  );
  assert.deepEqual(parseResult(result), JSON.parse(upstream), "回包必須原樣透傳（含 ok:false / errors / qc_signature）");

  // 上游失敗：與其他轉發工具同語義（isError + 原文）。
  const failed = fakeDispatcher({ status: 400, text: '{"error":{"code":"invalid_expert_id"}}' });
  const failedResult = await callTool("check_delivery_contract", args, ctx(failed.dispatcher));
  assert.equal(failedResult.isError, true);
  assert.match(failedResult.content[0].text, /HTTP 400/);
});

test("evaluate_media_quality：POST 到媒體硬檢端點、probe/policy 原樣轉發，probe_unavailable 誠實透傳", async () => {
  assert.ok(listToolNames().includes("evaluate_media_quality"), "listToolNames 缺 evaluate_media_quality");
  assert.ok(
    MCP_TOOLS.some((tool) => tool.name === "evaluate_media_quality"),
    "MCP_TOOLS 缺 evaluate_media_quality",
  );

  // 誠實路徑：伺服器量測不可用 ⇒ 回 ok:false + probe_unavailable；工具必須原樣透傳，
  // 不得改成 isError（量測沒發生不是工具錯誤）、更不得改成 ok:true（假通過）。
  const verdict = {
    ok: false,
    measured: { status: "probe_unavailable", container: null, width: null, duration_sec: null },
    failures: [{ code: "probe_unavailable", detail: "ffprobe 不存在（系統未安裝）" }],
    policyId: "video_default",
  };
  const { calls, dispatcher } = fakeDispatcher({ text: JSON.stringify(verdict) });
  const result = await callTool(
    "evaluate_media_quality",
    { media_url: "https://cdn.example/a.mp4", policy: "video_default" },
    ctx(dispatcher),
  );
  assert.equal(result.isError, undefined, "量測沒發生是誠實的 verdict，不是 isError");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/harness/media/quality");
  assert.equal(calls[0].authorization, `Bearer ${VALID_KEY}`);
  assert.deepEqual(calls[0].body, { media_url: "https://cdn.example/a.mp4", policy: "video_default" });
  const payload = parseResult(result) as { ok: boolean; failures: Array<{ code: string }> };
  assert.equal(payload.ok, false, "probe_unavailable 不得被透傳成 ok:true");
  assert.equal(payload.failures[0].code, "probe_unavailable");

  // 呼叫方自帶 probe：原樣轉發；省略的 media_url 不得被塞成 null/預設值。
  const withProbe = fakeDispatcher({ text: JSON.stringify({ ok: true, measured: {}, failures: [], policyId: "audio_default" }) });
  const probe = {
    status: "ok",
    error: null,
    container: "mp3",
    durationSec: 3,
    sizeBytes: 4096,
    video: null,
    audio: { codec: "mp3", meanVolumeDb: -18, maxVolumeDb: -3 },
  };
  await callTool("evaluate_media_quality", { probe, policy: "audio_default" }, ctx(withProbe.dispatcher));
  assert.deepEqual(withProbe.calls[0].body, { probe, policy: "audio_default" }, "省略的 media_url 不得憑空補欄位");
});

// ─────────────────────────────────────────── 7. MCP 工具目標路由漂移探針
//
// 病（2026-10-03 線上事故）：閘門工具把轉發目標宣告成 `/api/v1/expert/deliverable/validate`
// 與 `/api/v1/media/quality`。`/api/v1/:path*` 被 `next.config.mjs` 的 beforeFiles **整包**
// 代理給控制面（`/image-control/api/v1/:path*`），而控面沒有這兩條 route ⇒ 工具在生產永遠
// 收到 404 HTML，且**沒有任何測試會咬**（路徑字串斷言照樣全綠）。
//
// 本探針補上兩條正交的不變式（不改弱任何既有斷言）：
//
//  A. **落地不變式（route 必須存在）**：每支工具的轉發目標在站內（`src/app/api/**`）都必須
//     有對應的 `route.ts`。判準之所以成立：控面是**同一份 Next 應用**（basePath
//     `/image-control`，同一 repo 部署），故「本地有 mirror route」正是「控面也有」的證據；
//     本地沒有、目標又落在代理前綴內 ⇒ 控面也沒有 ⇒ 生產 404。這是事故的**結果形狀**，
//     也覆蓋「忘了建 route 就把工具接上去」。
//  B. **代理棘輪（不得被遮蔽）**：工具目標落在代理清單內＝交付給控面執行，只有**刻意代理**
//     的 B 端 API 面（`DELEGATED_TOOL_TARGETS`）才安全；其餘命中代理清單的目標一律紅
//     ——那正是事故的**成因形狀**（路由寫在代理前綴下、本地看似有、生產永遠跑不到）。
//
// 抽取方式刻意用**真行為**而非源碼正則：以假 dispatcher 逐支跑工具（含各分支變體），捕獲
// `runForward` 真正解析出的路徑——函式路徑、模板插值、encodeURIComponent 都如實落地，
// 不會因重寫成別種字串寫法而漏檢或誤報。

const MCP_TEST_API_DIR = path.resolve(__dirname, "..", "..", "app", "api");

/** 收集 `src/app/api/**` 下所有 `route.ts`。 */
function collectRouteFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) collectRouteFiles(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

/** route.ts 的路徑 → URL 段（去掉 Next 的 route group `(x)`）。 */
function routeUrlSegments(file: string): string[] {
  return path
    .relative(MCP_TEST_API_DIR, path.dirname(file))
    .split(path.sep)
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")));
}

/** 站內 URL 路徑 → 相對 `src/app/api` 的段（去掉前導 `api`）；route 段同口徑。 */
function urlPathSegments(urlPath: string): string[] {
  const segs = urlPath.replace(/^\/+/, "").split("/").filter((seg) => seg !== "");
  return segs[0] === "api" ? segs.slice(1) : segs;
}

/**
 * Next 動態段語義：`[x]` 匹配恰好一段、`[...x]` 匹配 1+ 段、`[[...x]]` 匹配 0+ 段。
 * 段數與字面段必須完全對上（不做尾綴鬆散匹配），否則 `/api/harness/media` 會被
 * `/api/harness/media/quality` 誤判為存在。
 */
function routeSegmentsMatch(pathSegs: string[], routeSegs: string[]): boolean {
  let pi = 0;
  for (let ri = 0; ri < routeSegs.length; ri += 1) {
    const routeSeg = routeSegs[ri];
    if (routeSeg.startsWith("[[...") && routeSeg.endsWith("]]")) return true; // 0+ 段，吃掉剩餘
    if (routeSeg.startsWith("[...") && routeSeg.endsWith("]")) return pathSegs.length - pi >= 1; // 1+ 段
    if (pi >= pathSegs.length) return false;
    if (routeSeg.startsWith("[") && routeSeg.endsWith("]")) {
      pi += 1; // 單段動態
      continue;
    }
    if (routeSeg !== pathSegs[pi]) return false;
    pi += 1;
  }
  return pi === pathSegs.length;
}

const ROUTE_URL_SEGMENTS: string[][] = collectRouteFiles(MCP_TEST_API_DIR).map(routeUrlSegments);

function hasLocalRoute(urlPath: string): boolean {
  const segs = urlPathSegments(urlPath);
  return ROUTE_URL_SEGMENTS.some((route) => routeSegmentsMatch(segs, route));
}

/** 命中控面代理清單則回該條 source（`:path*` 前綴語義，其餘精確相等），否則 null。 */
function matchedProxySource(urlPath: string): string | null {
  for (const source of CONTROL_PLANE_PROXY_SOURCES as readonly string[]) {
    if (source.endsWith("/:path*")) {
      const prefix = source.slice(0, -"/:path*".length);
      if (urlPath.startsWith(`${prefix}/`) && urlPath.length > prefix.length + 1) return source;
    } else if (urlPath === source) {
      return source;
    }
  }
  return null;
}

/**
 * 刻意的控面代理目標（棘輪基線，只准縮不准漲）。
 *
 * 這些是工具面真正要交給控面執行的 B 端 API 端點（帳本／worker／畫布庫都在控面）。
 * 不在基線內、卻又命中代理清單的工具目標一律紅——因為控面不一定有那條 route，
 * 而本地 route 也永遠跑不到（遮蔽）。新增合法代理目標時，必須在此登記並寫明理由。
 * 動態段寫成 `[x]`。**`/api/harness/**` 這類本地執行的目標不在此列**（它們不命中代理）。
 */
const DELEGATED_TOOL_TARGETS: Record<string, string> = {
  "/api/v1/models": "list_models：模型能力面/熔斷讀控面 generation DB",
  "/api/v1/images/generations": "generate_image：帳本/worker 在控面",
  "/api/v1/images/edits": "edit_image：帳本/worker 在控面",
  "/api/v1/videos/generations": "generate_video：帳本/worker 在控面",
  "/api/v1/tts/generations": "tts：帳本/worker 在控面",
  "/api/v1/upscale": "upscale：帳本/worker 在控面",
  "/api/v1/quota": "get_quota：餘額帳本在控面",
  "/api/v1/images/[id]/result": "get_result(kind=image)：任務結果讀控面帳本",
  "/api/v1/videos/[id]/result": "get_result(kind=video)：任務結果讀控面帳本",
  "/api/v1/tts/[id]": "get_result(kind=tts)：任務結果讀控面帳本",
  "/api/v1/canvas/projects": "list_canvas_projects：畫布 project-store 觸控面庫",
  "/api/v1/workflow/compile": "workflow_write（純編譯）：畫布編譯在控面",
  "/api/v1/canvas/workflow": "workflow_write（落圖）：畫布專案在控面庫",
  "/api/v1/canvas/nodes/[id]/revert": "workflow_rollback：畫布節點版本在控面庫",
};

const DELEGATED_TOOL_TARGET_SEGMENTS: string[][] = Object.keys(DELEGATED_TOOL_TARGETS).map(urlPathSegments);

function isDelegatedToolTarget(urlPath: string): boolean {
  const segs = urlPathSegments(urlPath);
  return DELEGATED_TOOL_TARGET_SEGMENTS.some((pattern) => routeSegmentsMatch(segs, pattern));
}

/**
 * 逐支工具跑一次（含分支變體），用假 dispatcher 捕獲**真實解析出的**站內轉發路徑。
 * 回傳 `路徑 → 宣告該路徑的工具名集合`。
 */
async function captureToolTargetPaths(): Promise<Map<string, Set<string>>> {
  const byPath = new Map<string, Set<string>>();
  const variantsFor = (name: string): Array<Record<string, unknown>> => {
    if (name === "get_result") {
      return [
        { kind: "image", id: "cap-1" },
        { kind: "video", id: "cap-1" },
        { kind: "tts", id: "cap-1" },
      ];
    }
    if (name === "get_agent_session") {
      return [
        { session_id: "cap-1", view: "summary" },
        { session_id: "cap-1", view: "transcript" },
        { session_id: "cap-1", view: "raw" },
      ];
    }
    if (name === "workflow_write") {
      return [
        { source: { workflow: "cap", steps: [{ id: "a", title: "A" }] } },
        { source: { workflow: "cap", steps: [{ id: "a", title: "A" }] }, project_id: "cap-proj" },
      ];
    }
    return [VALID_ARGS[name] ?? {}];
  };

  for (const tool of MCP_TOOLS) {
    for (const args of variantsFor(tool.name)) {
      const hitsThisRun = new Map<string, number>();
      const dispatcher: McpDispatcher = async (request) => {
        const owners = byPath.get(request.path) ?? new Set<string>();
        owners.add(tool.name);
        byPath.set(request.path, owners);
        // run_agent 的輪詢：第二輪必須給出 assistant 訊息才會結束（否則假時鐘無限輪詢）。
        if (request.method === "GET" && /^\/api\/agent\/biz\/sessions\/[^/]+$/.test(request.path)) {
          const hits = (hitsThisRun.get(request.path) ?? 0) + 1;
          hitsThisRun.set(request.path, hits);
          return {
            status: 200,
            contentType: "application/json",
            text: JSON.stringify(
              hits === 1
                ? { message_count: 0, messages: [] }
                : { message_count: 1, messages: [{ role: "assistant", text: "cap" }] },
            ),
          };
        }
        return { status: 200, contentType: "application/json", text: "{}" };
      };
      let tick = 0;
      const now = () => (tick += 1_000);
      await callTool(tool.name, args, ctx(dispatcher, `Bearer ${VALID_KEY}`, { sleep: async () => {}, now }));
    }
  }
  return byPath;
}

test("漂移探針：每支 MCP 工具的轉發目標都能落地，且沒有被控面代理遮蔽的目標", async () => {
  const captured = await captureToolTargetPaths();
  assert.ok(captured.size >= 15, `只捕獲 ${captured.size} 條目標路徑，捕獲器可能失效`);

  const missingRoute: string[] = [];
  const shadowed: string[] = [];

  for (const [urlPath, owners] of [...captured.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const tools = [...owners].sort().join(" / ");
    const source = matchedProxySource(urlPath);
    const local = hasLocalRoute(urlPath);

    // A. 落地不變式：目標必須有對應 route.ts（控面是同 repo 的 mirror，本地即是控面證據）。
    if (!urlPath.startsWith("/api/")) {
      missingRoute.push(`工具 ${tools} 的目標 ${urlPath} 不是站內絕對路徑（/api/...），無法判定（一律紅）`);
    } else if (!local) {
      const why = source
        ? `命中控面代理（${source}）但本地沒有對應 route.ts——控面是同一份 repo，沒有 mirror 即控面也沒有`
        : "既不在控面代理清單、本地也沒有 route.ts";
      missingRoute.push(`工具 ${tools} 的目標 ${urlPath} ${why}（生產會 404）`);
    }

    // B. 代理棘輪：命中代理清單卻不在刻意代理基線內 ⇒ 被遮蔽（本地 route 生產永遠跑不到）。
    if (source && local && !isDelegatedToolTarget(urlPath)) {
      shadowed.push(
        `工具 ${tools} 的目標 ${urlPath} 既被控面代理（${source}）又在本地存在 route.ts——該 route 生產永遠跑不到。` +
          `要嘛把工具改到未被代理的路徑（如 /api/harness/**），要嘛在 DELEGATED_TOOL_TARGETS 登記並寫明控面確有該 route。`,
      );
    }
  }

  assert.deepEqual(
    missingRoute,
    [],
    `MCP 工具目標指向不存在的站內路由（生產會 404）：\n  ${missingRoute.join("\n  ")}`,
  );
  assert.deepEqual(
    shadowed,
    [],
    `MCP 工具目標被控面代理遮蔽（路由寫了卻跑不到）：\n  ${shadowed.join("\n  ")}`,
  );
});
