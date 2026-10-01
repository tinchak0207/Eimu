/**
 * MCP 工具表與執行層——**只做轉發與投影，零業務、零計費**。
 *
 * 硬規則（改本檔前先讀，這是本檔存在的理由）：
 * 1. **不重寫任何業務**。10 條工具裡，8 條是「把參數原樣交給既有 `/api/v1/**` 端點」
 *    （帳本、冪等、配額預檢、退款、上游路由全在那些端點裡），2 條是對既有 skill 註冊表
 *    的唯讀投影。本檔**沒有**任何金額、模型白名單、配額或扣費判斷。
 * 2. **鑑權逐字複用**。工具自身不驗 key；呼叫者的 `Authorization` 頭原樣透傳給 `/v1`，
 *    由同一支 `authenticateBizApiKey` 決定身分與計費主體（見 `src/app/api/mcp/route.ts`）。
 * 3. **私有 skill 永不外露**。只用 registry 的公開族函式（`listPublicSkills` 等），
 *    絕不調 `listMySkills` / `getMySkillById`，也不接受任何 owner 參數。
 * 4. **失敗不裝死也不炸**。上游 4xx/5xx、網路中斷一律回 `isError: true` 的工具結果
 *    （模型看得見原文、能自行修正）；只有「參數不合 schema」才是 JSON-RPC -32602。
 *
 * 傳輸選擇：轉發走**站內 HTTP**（`<origin>/api/v1/...`），不是 in-process 呼叫路由函式。
 * 理由寫在 `createHttpDispatcher` 的註解裡。
 */

import { AGENT_SKILL_FAMILY_LABELS } from "@/lib/agent-skills";
import {
  getSkillByIdPublic,
  listPublicSkills,
  listSkillFamilies,
  searchPublicSkills,
  type AgentSkillView,
} from "@/lib/agent-skills/registry";
import {
  JSON_RPC_ERROR_CODES,
  MAX_TOOL_TEXT_LENGTH,
  McpRpcError,
  textResult,
  truncateToolText,
  type McpToolCallResult,
  type McpToolDescriptor,
} from "./protocol";

// ─────────────────────────────────────────── JSON Schema（本檔用到的子集）

export type ToolSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array";

/**
 * 只實作 protocol 需要的 JSON Schema 子集：type / properties / required /
 * additionalProperties / enum / minimum / maximum / minItems / maxItems / items。
 * **刻意不用 anyOf/oneOf**——驗證器與宣告是同一份 schema，不用兩套真源。
 */
export type ToolInputSchema = {
  type: ToolSchemaType;
  description?: string;
  properties?: Record<string, ToolInputSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: ToolInputSchema;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 依 schema 驗證工具參數。通過回 `null`，失敗回**第一條**人話錯誤訊息（含路徑）。
 * 純函式、不拋錯——拋與否由 `callTool` 決定，方便測試與路由各取所需。
 */
export function validateToolArguments(schema: ToolInputSchema, args: unknown): string | null {
  return validateValue(schema, args, "arguments");
}

function validateValue(schema: ToolInputSchema, value: unknown, path: string): string | null {
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    return `${path} 只能是 ${schema.enum.join(" / ")} 之一（收到 ${JSON.stringify(value)}）`;
  }

  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) return `${path} 必須是物件`;
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) return `${path}.${key} 是必填參數`;
      }
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const property = schema.properties?.[key];
        if (!property) {
          if (schema.additionalProperties === false) return `${path}.${key} 不是本工具支援的參數`;
          continue;
        }
        const problem = validateValue(property, item, `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} 必須是陣列`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} 至少需要 ${schema.minItems} 個元素`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} 最多 ${schema.maxItems} 個元素（收到 ${value.length} 個）`;
      }
      if (schema.items) {
        for (let index = 0; index < value.length; index += 1) {
          const problem = validateValue(schema.items, value[index], `${path}[${index}]`);
          if (problem) return problem;
        }
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${path} 必須是字串`;
      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${path} 必須是整數`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} 必須是數字`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${path} 必須是布林值`;
      return null;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} 不得小於 ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} 不得大於 ${schema.maximum}`;
  }
  return null;
}

// ─────────────────────────────────────────── 轉發層（可注入）

export interface McpDispatchRequest {
  method: "GET" | "POST";
  /** 站內路徑，例如 `/api/v1/images/generations`（不含 origin、不含 query）。 */
  path: string;
  /** 呼叫者原始 `Authorization` 頭，逐字透傳。 */
  authorization: string | null;
  traceId: string;
  /** 工具名，只用於組冪等鍵，不進上游 body。 */
  toolName: string;
  body?: unknown;
}

export interface McpDispatchResponse {
  status: number;
  contentType: string;
  text: string;
}

/** 轉發介面：工具測試注入假實作，生產用 `createHttpDispatcher`。 */
export type McpDispatcher = (request: McpDispatchRequest) => Promise<McpDispatchResponse>;

export interface McpToolContext {
  /** 呼叫者的 `Authorization` 頭（原樣，不解析、不改寫）。 */
  authorization: string | null;
  /** 貫穿本次 MCP 呼叫的 trace id（同時當上游 `X-Request-Id`）。 */
  traceId: string;
  dispatcher: McpDispatcher;
}

/** 轉發逾時：與 `/v1` 路由的 maxDuration 同量級，生圖/生視頻是長請求。 */
const DISPATCH_TIMEOUT_MS = 280_000;

/**
 * 生產用轉發器：對**自家站點**發 HTTP 請求打 `/api/v1/**`。
 *
 * 為什麼是站內 HTTP 而不是 in-process 呼叫路由函式（兩者都合法，這裡選前者）：
 * - `/api/v1/**` 在生產被 `next.config.mjs` 的 `beforeFiles` 改寫到控制面
 *   （`/image-control/api/v1/**`），**真正的帳本與 worker 在那邊**。站內 HTTP 讓 MCP
 *   與外部 API 客戶走**同一條**生產路徑（同一支閘、同一本帳），in-process 反而會
 *   繞過那層改寫、在控制面模式下打到站點自己的舊分支。
 * - 呼叫者的 `Authorization` 逐字透傳 ⇒ 計費主體與配額判斷與 `/v1` 完全一致。
 *
 * 不變式：任何 log / 錯誤訊息都不得包含 `authorization` 的值（本函式只把它放進請求頭）。
 */
export function createHttpDispatcher(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): McpDispatcher {
  const base = origin.replace(/\/+$/, "");
  return async (request) => {
    const headers: Record<string, string> = {
      Accept: "application/json",
      // 沿用既有 trace 慣例：上游路由的 getOrCreateTraceId 會原樣回聲。
      "X-Request-Id": request.traceId,
      // 同一次 MCP 呼叫重送不會重複扣費；鍵與 traceId 綁定，不會跨呼叫誤命中。
      "Idempotency-Key": `mcp:${request.toolName}:${request.traceId}`,
    };
    if (request.authorization) headers.Authorization = request.authorization;

    let payload: string | undefined;
    if (request.method === "POST") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(request.body ?? {});
    }

    const response = await fetchImpl(`${base}${request.path}`, {
      method: request.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      redirect: "manual",
    });

    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      text: await response.text(),
    };
  };
}

// ─────────────────────────────────────────── 工具定義

/** 只丟掉 `undefined`（`null`/空字串是呼叫者的真實意圖，不代他決定）。 */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function bilingual(zh: string, en: string): string {
  return `${zh}\nEnglish: ${en}`;
}

function asRecord(args: unknown): Record<string, unknown> {
  return isPlainObject(args) ? args : {};
}

function pickString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

// 生圖/改圖的模型 id（`generate_image` 的 `model` 上游是必填，schema 同步宣告為必填）。
const SKILL_FAMILIES = Object.keys(AGENT_SKILL_FAMILY_LABELS) as string[];
const DEFAULT_SKILL_LIMIT = 30;
const MAX_SKILL_LIMIT = 200;

function skillSummary(skill: AgentSkillView) {
  return {
    id: skill.id,
    name: skill.name,
    family: skill.family,
    source: skill.source,
    oneLiner: skill.oneLiner,
    outputKind: skill.outputKind,
    useScenario: skill.useScenario,
    inputType: skill.inputType,
    outputContent: skill.outputContent,
    tags: skill.tags,
    ...(skill.templateId ? { templateId: skill.templateId } : {}),
  };
}

interface ToolDefinition extends McpToolDescriptor {
  inputSchema: ToolInputSchema;
  run(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolCallResult>;
}

/** 一條轉發工具的全部資訊：目標端點 + body 投影（投影只做挑欄位，不改語義）。 */
interface ForwardSpec {
  method: "GET" | "POST";
  path: string | ((args: Record<string, unknown>) => string);
  body?: (args: Record<string, unknown>) => Record<string, unknown>;
}

async function runForward(
  spec: ForwardSpec,
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<McpToolCallResult> {
  const path = typeof spec.path === "function" ? spec.path(args) : spec.path;
  const response = await ctx.dispatcher({
    method: spec.method,
    path,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
    body: spec.body ? spec.body(args) : undefined,
  });

  const text = truncateToolText(response.text);
  if (response.status >= 200 && response.status < 300) return textResult(text);
  return textResult(`上游 ${spec.method} ${path} 回應 HTTP ${response.status}：\n${text}`, true);
}

async function runListSkills(args: Record<string, unknown>): Promise<McpToolCallResult> {
  const query = pickString(args, "query");
  const family = pickString(args, "family");
  const limit = typeof args.limit === "number" ? args.limit : DEFAULT_SKILL_LIMIT;

  const all = await listPublicSkills();
  const matched = query ? await searchPublicSkills(query) : all;
  const filtered = family ? matched.filter((skill) => skill.family === family) : matched;
  const page = filtered.slice(0, limit);

  return textResult(
    JSON.stringify(
      {
        total: filtered.length,
        count: page.length,
        families: listSkillFamilies(all),
        skills: page.map(skillSummary),
      },
      null,
      2,
    ),
  );
}

async function runGetSkill(args: Record<string, unknown>): Promise<McpToolCallResult> {
  const id = pickString(args, "id") ?? "";
  const skill = await getSkillByIdPublic(id);
  if (!skill) {
    return textResult(`未找到 id 為 ${id} 的公開技能（私有技能不在此面暴露）。`, true);
  }
  return textResult(
    JSON.stringify(
      {
        ...skillSummary(skill),
        toolIds: skill.toolIds,
        ...(skill.expertId ? { expertId: skill.expertId } : {}),
        ...(skill.aesthetic ? { aesthetic: skill.aesthetic } : {}),
      },
      null,
      2,
    ),
  );
}

function defineTools(): ToolDefinition[] {
  return [
    {
      name: "list_skills",
      title: "列出公开技能",
      description: bilingual(
        "列出公开技能库（builtin / recipe / template 三个来源），可按关键词与题材家族筛选。返回家族 facet 与条目摘要；只返回公开技能，用户私有技能永不出现。",
        "List public skills (builtin / recipe / template) with optional keyword and family filters.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词（风格名/流派/题材/拍摄手法），匹配名称、一句话说明与标签。" },
          family: { type: "string", enum: SKILL_FAMILIES, description: "题材家族 id，见返回的 families 字段。" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SKILL_LIMIT,
            description: `返回条数上限，默认 ${DEFAULT_SKILL_LIMIT}。`,
          },
        },
        additionalProperties: false,
      },
      run: (args) => runListSkills(args),
    },
    {
      name: "get_skill",
      title: "读取单个技能",
      description: bilingual(
        "按 id 读取一条公开技能的完整条目（适用场景、输入面、交付物、可调用工具、主责 Expert、美学锚）。私有技能与此面无关，查不到即不存在。",
        "Read one public skill entry by id.",
      ),
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "技能 id（来自 list_skills）。" } },
        required: ["id"],
        additionalProperties: false,
      },
      run: (args) => runGetSkill(args),
    },
    {
      name: "list_models",
      title: "列出可用模型",
      description: bilingual(
        "列出当前 API key 可用的图像/视频模型，含端点归属（x_endpoint）、能力面与计价（x_coins_per_image / x_coins_per_second）。生成类工具调用前先用它取 model id。",
        "List models available to the current API key, including endpoint routing and pricing metadata. Call this before generate_image / generate_video to obtain a model id.",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) =>
        runForward({ method: "GET", path: "/api/v1/models" }, "list_models", args, ctx),
    },
    {
      name: "generate_image",
      title: "生成图像",
      description: bilingual(
        "按提示词生成图像（同步返回）。计费与配额走既有账本，与 /v1/images/generations 完全同一条扣费路径。因 MCP 结果是文本，默认以 response_format=url 返回链接（除非显式传 b64_json）。",
        "Generate images from a prompt, billed through the same ledger path as /v1/images/generations. Defaults to response_format=url so the text result stays usable.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "提示词，必填，最长 4000 字符。" },
          model: { type: "string", description: "模型 id（必填，先用 list_models 取）。" },
          size: {
            type: "string",
            enum: ["1024x1024", "1536x1024", "1024x1536", "2048x2048"],
            description: "输出尺寸，默认 1024x1024。",
          },
          n: { type: "integer", minimum: 1, maximum: 4, description: "出图张数，1-4，默认 1。" },
          reference_images: {
            type: "array",
            maxItems: 5,
            items: { type: "string", description: "http(s) 或 data:image URL。" },
            description: "参考图 URL 列表，最多 5 张。",
          },
          response_format: { type: "string", enum: ["url", "b64_json"], description: "返回形态，默认 url。" },
        },
        required: ["prompt", "model"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: "/api/v1/images/generations",
            body: (a) => compact({ ...a, response_format: a.response_format ?? "url" }),
          },
          "generate_image",
          args,
          ctx,
        ),
    },
    {
      name: "edit_image",
      title: "编辑图像",
      description: bilingual(
        "对一张输入图按提示词做编辑（同步返回）。image 为图片 URL。计费与配额走既有账本，与 /v1/images/edits 同一条路径。",
        "Edit an input image with a prompt, billed through the same ledger path as /v1/images/edits.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "输入图 URL（http(s) 或 data:image）。" },
          prompt: { type: "string", description: "编辑指令，必填，最长 2000 字符。" },
          model: { type: "string", description: "模型 id，可选；缺省走默认编辑模型。" },
          size: { type: "string", enum: ["1k", "2k"], description: "输出尺寸档，默认 1k。" },
          n: { type: "integer", minimum: 1, maximum: 4, description: "出图张数，1-4，默认 1。" },
          response_format: { type: "string", enum: ["url", "b64_json"], description: "返回形态，默认 url。" },
        },
        required: ["image", "prompt"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: "/api/v1/images/edits",
            body: (a) => compact({ ...a, response_format: a.response_format ?? "url" }),
          },
          "edit_image",
          args,
          ctx,
        ),
    },
    {
      name: "generate_video",
      title: "生成视频",
      description: bilingual(
        "提交视频生成任务（异步，返回 task 与 id，用 get_result 轮询）。计费与配额走既有账本，与 /v1/videos/generations 同一条路径。",
        "Submit an asynchronous video generation task (poll with get_result), billed through the same ledger path as /v1/videos/generations.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "提示词，必填，最长 4000 字符。" },
          model: { type: "string", description: "视频模型 id（必填，先用 list_models 取）。" },
          n: { type: "integer", minimum: 1, maximum: 4, description: "任务数，1-4，默认 1。" },
          size: { type: "string", description: "分辨率或画幅，如 1920x1080 / 16:9。" },
          duration_seconds: { type: "number", description: "时长（秒），可选，取值见模型能力面。" },
          generate_audio: { type: "boolean", description: "是否带音轨（模型支持时）。" },
          callback_url: { type: "string", description: "完成回调地址，可选。" },
        },
        required: ["prompt", "model"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          { method: "POST", path: "/api/v1/videos/generations", body: (a) => compact(a) },
          "generate_video",
          args,
          ctx,
        ),
    },
    {
      name: "tts",
      title: "文本转语音",
      description: bilingual(
        "提交文本转语音任务（异步，返回 task 与 id，用 get_result 轮询）。计费与配额走既有账本，与 /v1/tts/generations 同一条路径。",
        "Submit an asynchronous text-to-speech task (poll with get_result), billed through the same ledger path as /v1/tts/generations.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "要朗读的文本，必填，最长 5000 字符。" },
          voice: { type: "string", description: "音色 id，默认 default。" },
          model: { type: "string", description: "TTS 模型 id，默认 tts-1。" },
          callback_url: { type: "string", description: "完成回调地址，可选。" },
        },
        required: ["input"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward({ method: "POST", path: "/api/v1/tts/generations", body: (a) => compact(a) }, "tts", args, ctx),
    },
    {
      name: "upscale",
      title: "图像放大",
      description: bilingual(
        "放大一张图像。计费与配额走既有账本（含幂等预留与失败退款），与 /v1/upscale 同一条路径。",
        "Upscale an image, billed through the same ledger path as /v1/upscale (including idempotent reserve and refund on failure).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string", description: "输入图 URL，必填。" },
          factor: { type: "number", minimum: 1, maximum: 4, description: "放大倍数，默认 2。" },
          ratio: { type: "string", description: "目标画幅比，可选。" },
          size: { type: "string", enum: ["1k", "2k"], description: "输出尺寸档，默认 1k。" },
        },
        required: ["image"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward({ method: "POST", path: "/api/v1/upscale", body: (a) => compact(a) }, "upscale", args, ctx),
    },
    {
      name: "get_quota",
      title: "查询余额",
      description: bilingual(
        "查询当前 API key 绑定账户的余额与币种（与 /v1/quota 同源账本）。",
        "Read the balance and currency of the account bound to the current API key (same ledger as /v1/quota).",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) => runForward({ method: "GET", path: "/api/v1/quota" }, "get_quota", args, ctx),
    },
    {
      name: "get_result",
      title: "轮询任务结果",
      description: bilingual(
        "按任务 id 取异步结果：kind=image（/v1/images/{id}/result）、kind=video（/v1/videos/{id}/result）、kind=tts（/v1/tts/{id}）。生成类工具返回的 id 用它查。",
        "Fetch an asynchronous task result by id: kind=image, kind=video or kind=tts.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["image", "video", "tts"], description: "任务类型。" },
          id: { type: "string", description: "任务 id（generate_* / tts 返回）。" },
        },
        required: ["kind", "id"],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const kind = pickString(args, "kind") ?? "";
        const id = encodeURIComponent(pickString(args, "id") ?? "");
        const path = kind === "image" ? `/api/v1/images/${id}/result` : kind === "tts" ? `/api/v1/tts/${id}` : `/api/v1/videos/${id}/result`;
        return runForward({ method: "GET", path }, "get_result", args, ctx);
      },
    },
  ];
}

const TOOL_DEFINITIONS: ToolDefinition[] = defineTools();

const TOOL_INDEX: Map<string, ToolDefinition> = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

/** `tools/list` 的回應內容（只暴露 descriptor，不外洩 run/schema 內部物件）。 */
export const MCP_TOOLS: readonly McpToolDescriptor[] = TOOL_DEFINITIONS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
}));

export function listToolNames(): string[] {
  return TOOL_DEFINITIONS.map((tool) => tool.name);
}

/**
 * 執行一次 `tools/call`。
 * - 未知工具 → `isError: true` 的工具結果（**不是** -32600/-32601，模型看得懂並能自救）。
 * - 參數不合 schema → 拋 `McpRpcError(-32602)`，由 route 轉成 JSON-RPC 錯誤。
 * - 上游/網路失敗 → `isError: true` 的工具結果，附上游原文（已消毒、已截斷）。
 */
export async function callTool(
  name: string,
  rawArguments: unknown,
  ctx: McpToolContext,
): Promise<McpToolCallResult> {
  const tool = TOOL_INDEX.get(name);
  if (!tool) {
    return textResult(`未知工具：${name}。可用工具请调用 tools/list。`, true);
  }

  // MCP 允許省略 arguments；null 也當空物件（比照官方 SDK 的寬容度）。
  const args = rawArguments === undefined || rawArguments === null ? {} : rawArguments;
  const problem = validateToolArguments(tool.inputSchema, args);
  if (problem) {
    throw new McpRpcError(JSON_RPC_ERROR_CODES.invalidParams, `工具 ${name} 参数不合法：${problem}`);
  }

  try {
    return await tool.run(asRecord(args), ctx);
  } catch (error) {
    if (error instanceof McpRpcError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // 只回訊息、不回 stack；dispatch 失敗的原文經消毒後可見。
    return textResult(`工具 ${name} 执行失败：${truncateToolText(message, 2_000)}`, true);
  }
}

/** 供測試檢查 schema 與描述（不要拿它做生產邏輯）。 */
export function __getToolSchemaForTests(name: string): ToolInputSchema | undefined {
  return TOOL_INDEX.get(name)?.inputSchema;
}

export { MAX_TOOL_TEXT_LENGTH };
