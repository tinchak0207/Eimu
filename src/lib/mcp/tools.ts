/**
 * MCP 工具表與執行層——**只做轉發與投影，零業務、零計費**。
 *
 * 硬規則（改本檔前先讀，這是本檔存在的理由）：
 * 1. **不重寫任何業務**。生成/查詢類工具「把參數原樣交給既有 `/api/v1/**` 端點」
 *    （帳本、冪等、配額預檢、退款、上游路由全在那些端點裡）；skill 族是對既有註冊表的
 *    唯讀投影；工作流族（`workflow_write/history/read/rollback`＋`canvas_get_state`）
 *    是既有編譯器/畫布端點的薄轉發（讀面只挑欄位投影）。本檔**沒有**任何金額、
 *    模型白名單、配額、扣費或編譯/回滾語義的判斷。
 * 2. **鑑權逐字複用**。工具自身不驗 key；呼叫者的 `Authorization` 頭原樣透傳，
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
import { EXPERT_IDS } from "@/lib/expert-contract";
import {
  buildGenerationRequestHeaders,
  mcpGenerationIdempotencyKey,
} from "@/lib/generation-request-headers";
import { QUALITY_POLICIES } from "@/lib/media-quality-gate";
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
  /**
   * 輪詢用睡眠；預設 `setTimeout`。**可注入**：測試傳 no-op，避免真的等秒
   * （照 `openai-compat/generation.ts` 的 `input.sleep ?? defaultSleep` 慣例）。
   */
  sleep?: (ms: number) => Promise<void>;
  /** 時鐘；預設 `Date.now`。**可注入**：測試用假時鐘驅動 `run_agent` 的逾時路徑。 */
  now?: () => number;
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
 *
 * `origin` 兩種形態：
 * - **字串**：站點 origin，URL = `origin（去尾斜線） + path`（既有行為，逐字不變）。
 * - **函式**：`(path) => 完整絕對 URL`。route.ts 用它為**每個請求**挑轉發目標——
 *   公開站點 origin（Cloudflare 前置）與不掛 CF 的控制面 origin 不是同一個
 *   （見 `src/app/api/mcp/route.ts` 的 `resolveDispatchUrl`）。函式回傳值即最終 URL，
 *   本函式不再拼一次 path。
 */
export function createHttpDispatcher(
  origin: string | ((path: string) => string),
  fetchImpl: typeof fetch = fetch,
): McpDispatcher {
  const urlFor =
    typeof origin === "function"
      ? origin
      : (path: string) => `${origin.replace(/\/+$/, "")}${path}`;
  return async (request) => {
    // 生成型請求的 trace / 冪等鍵紀律收斂在 generation-request-headers（R5）：
    // `X-Request-Id` 沿用本次 MCP 呼叫的 traceId（上游 getOrCreateTraceId 會原樣回聲），
    // 冪等鍵與 traceId 綁定（同一次呼叫重送不重複扣費，不跨呼叫誤命中）。
    const headers = buildGenerationRequestHeaders({
      traceId: request.traceId,
      idempotencyKey: mcpGenerationIdempotencyKey(request.toolName, request.traceId),
      authorization: request.authorization,
      accept: "application/json",
    });

    let payload: string | undefined;
    if (request.method === "POST") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(request.body ?? {});
    }

    const response = await fetchImpl(urlFor(request.path), {
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

/** 媒體硬檢政策的鍵（單一真源＝`media-quality-gate` 的 `QUALITY_POLICIES`，不另抄一份）。 */
const QUALITY_POLICY_IDS = Object.keys(QUALITY_POLICIES) as string[];

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

/**
 * 讀面轉發：錯誤語義與 `runForward` 逐字一致（上游非 2xx 回原文 isError），
 * 差別只在成功時把上游 JSON **投影**出需要的欄位（只挑欄位/過濾，不重算、不改語義——
 * 與 `runListSkills`/`runGetSkill` 同層）。投影或解析失敗一律回原文，絕不把上游回應弄丟。
 */
async function runForwardProjected(
  spec: ForwardSpec,
  toolName: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
  project: (payload: unknown) => unknown,
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
  if (response.status < 200 || response.status >= 300) {
    return textResult(`上游 ${spec.method} ${path} 回應 HTTP ${response.status}：\n${text}`, true);
  }
  try {
    return textResult(JSON.stringify(project(JSON.parse(response.text)), null, 2));
  } catch {
    return textResult(text);
  }
}

/** 畫布快照端點（B 端 key 經 `/api/agent/biz` 代理到 agent 閘道）的站內路徑。 */
function canvasStatePath(args: Record<string, unknown>): string {
  const sessionId = pickString(args, "session_id") ?? "";
  return `/api/agent/biz/sessions/${encodeURIComponent(sessionId)}/canvas/state`;
}

/** 從閘道快照回應挑出 `state`（快照本體）；非物件回空物件。 */
function snapshotState(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) return {};
  const state = (payload as { state?: unknown }).state;
  return isPlainObject(state) ? state : {};
}

// ─────────────────────────────────────────── Eimu agent 閘道（B 端密鑰 → /api/agent/biz 代理）
//
// 這條線早已存在：`/api/agent/biz/[...path]` 用**呼叫者自己的 B 端密鑰**鑑權，換發成業主派生 key
// 後轉發 VPS 閘道 `/agent/v1/<subPath>`，身分空間與網頁版 AI 助理完全相同（同 settings、
// 同 orchestrator、beast_mode 為帳號級設定）。本節只把它投影到工具面，不重寫任何業務。
// 硬限制：該代理的 JSON 路徑有 10s 逾時（`BIZ_PROXY_JSON_TIMEOUT_MS`），故 `run_agent`
// 必須「送一輪快回、之後反覆輪詢」，絕不能在一個請求裡等完整回合。

/** agent 會話站內路徑前綴（經 `/api/agent/biz` 代理到閘道 `/agent/v1/sessions`）。 */
const AGENT_SESSIONS_PATH = "/api/agent/biz/sessions";
/** agent 帳號級設定路徑（含 beast_mode）。 */
const AGENT_SETTINGS_PATH = "/api/agent/biz/settings";
/** `run_agent` 輪詢間隔；每次輪詢一律走簡化端點 `/sessions/{id}`（單次必須 <10s）。 */
const RUN_AGENT_POLL_INTERVAL_MS = 2_000;
const RUN_AGENT_DEFAULT_TIMEOUT_SECONDS = 180;
/** 上限同時硬編在 schema（maximum）；執行層再夾一次當防禦。 */
const RUN_AGENT_MAX_TIMEOUT_SECONDS = 300;

function agentSessionPath(sessionId: string, suffix = ""): string {
  return `${AGENT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}${suffix}`;
}

/** 預設睡眠（測試以 `ctx.sleep` 注入 no-op，不真的等秒）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 上游非 2xx：與 `runForward` 同語義的工具錯誤（附已消毒原文）。 */
function agentUpstreamFailure(method: string, path: string, response: McpDispatchResponse): McpToolCallResult {
  return textResult(
    `上游 ${method} ${path} 回應 HTTP ${response.status}：\n${truncateToolText(response.text)}`,
    true,
  );
}

/** 從 POST /sessions 回包取 `session_id`（形狀未實測：容忍頂層與 `session.session_id`，取不到回 undefined）。 */
function extractSessionId(payload: unknown): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  const direct = payload.session_id;
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();
  const nested = payload.session;
  if (isPlainObject(nested)) {
    const id = nested.session_id;
    if (typeof id === "string" && id.trim() !== "") return id.trim();
  }
  return undefined;
}

interface AgentMessage {
  role: string;
  text: string;
  created_at?: unknown;
}

/** 簡化 transcript 的 `messages`（非陣列/非物件一律略過，不假裝有內容）。 */
function readAgentMessages(payload: unknown): AgentMessage[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.messages)) return [];
  const out: AgentMessage[] = [];
  for (const entry of payload.messages) {
    if (!isPlainObject(entry)) continue;
    out.push({
      role: typeof entry.role === "string" ? entry.role : "",
      text: typeof entry.text === "string" ? entry.text : "",
      ...(entry.created_at !== undefined ? { created_at: entry.created_at } : {}),
    });
  }
  return out;
}

/** 上游 `message_count`（缺欄位回 null，由呼叫方回退成 `messages.length`）。 */
function readAgentMessageCount(payload: unknown): number | null {
  if (!isPlainObject(payload)) return null;
  const count = payload.message_count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

// ── artifacts 抽取（「透傳」的核心）：抽媒體 URL 的同時保留原文 reply ──

const ARTIFACT_IMAGE_EXTENSION = /\.(webp|png|jpe?g)(?:[?#]|$)/i;
const ARTIFACT_VIDEO_EXTENSION = /\.(mp4|webm|mov)(?:[?#]|$)/i;
const ARTIFACT_URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}]+/g;
const ARTIFACT_MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(https?:\/\/[^)\s]+)\s*\)/g;
/** 既知媒體目錄：即使無副檔名也當產物（kind=file）。 */
const ARTIFACT_MEDIA_PATH = "/image-data/files/";

function artifactKind(url: string): "image" | "video" | "file" {
  if (ARTIFACT_VIDEO_EXTENSION.test(url)) return "video";
  if (ARTIFACT_IMAGE_EXTENSION.test(url)) return "image";
  return "file";
}

/**
 * 從回覆文字抽出成品媒體 URL：`/image-data/files/…` 的圖片/影片，以及 markdown 圖片
 * `![alt](url)`（作者已宣告是圖）。非媒體的普通連結不列入。保持出現順序、同 URL 去重，
 * kind 以「更明確者優先」（image/video 不被 file 覆蓋）。
 */
function extractAgentArtifacts(text: string): Array<{ url: string; kind: "image" | "video" | "file" }> {
  const found = new Map<string, "image" | "video" | "file">();
  const consider = (raw: string, viaMarkdownImage: boolean) => {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (!/^https?:\/\//i.test(url)) return;
    const kind = artifactKind(url);
    // 原始 URL 只收媒體（已知副檔名或 /image-data/files/）；markdown 圖片一律收。
    if (!viaMarkdownImage && kind === "file" && !url.includes(ARTIFACT_MEDIA_PATH)) return;
    const resolved = viaMarkdownImage && kind === "file" ? "image" : kind;
    const existing = found.get(url);
    if (existing === "image" || existing === "video") return;
    found.set(url, resolved);
  };
  for (const match of text.matchAll(ARTIFACT_MARKDOWN_IMAGE_PATTERN)) consider(match[1], true);
  for (const match of text.matchAll(ARTIFACT_URL_PATTERN)) consider(match[0], false);
  return [...found.entries()].map(([url, kind]) => ({ url, kind }));
}

/**
 * 把任務交給 Eimu 的 agent orchestrator，並以**反覆輪詢**取回覆（單次請求一律 <10s）。
 *
 * 完成判準：基線（送訊息前的 `message_count`）之後出現 role=assistant 且 text 非空的訊息。
 * （規格裡的判準②「`/sessions` 列表 status=idle 且已有新 assistant 訊息」與①等價——
 * 兩者都要求「已有新 assistant 訊息」，故以①為單一判準，不多打一次列表請求。）
 *
 * 逾時不丟錯：回 status:"running" 與目前最後一則回覆，讓呼叫方自行用 `get_agent_session` 續查。
 */
async function runAgent(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolCallResult> {
  const prompt = pickString(args, "prompt") ?? "";
  const directive = pickString(args, "session_directive");
  const requestedTimeout =
    typeof args.timeout_seconds === "number" ? args.timeout_seconds : RUN_AGENT_DEFAULT_TIMEOUT_SECONDS;
  const timeoutSeconds = Math.min(Math.max(1, requestedTimeout), RUN_AGENT_MAX_TIMEOUT_SECONDS);
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? defaultSleep;
  const startedAt = now();
  const deadlineAt = startedAt + timeoutSeconds * 1000;

  let sessionId = pickString(args, "session_id") ?? "";
  if (!sessionId) {
    const created = await ctx.dispatcher({
      method: "POST",
      path: AGENT_SESSIONS_PATH,
      authorization: ctx.authorization,
      traceId: ctx.traceId,
      toolName: "run_agent",
      body: {},
    });
    if (created.status < 200 || created.status >= 300) {
      return agentUpstreamFailure("POST", AGENT_SESSIONS_PATH, created);
    }
    sessionId = extractSessionId(parseJsonLoose(created.text)) ?? "";
    if (!sessionId) {
      throw new Error("建立 agent 会话失败：上游回包没有 session_id（可用 list_agent_sessions 确认会话列表）。");
    }
  }

  // 基線：送訊息前的 message_count（判準靠它區分新舊回覆；讀不到就退回 0）。
  const before = await ctx.dispatcher({
    method: "GET",
    path: agentSessionPath(sessionId),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "run_agent",
  });
  const baselinePayload = before.status >= 200 && before.status < 300 ? parseJsonLoose(before.text) : undefined;
  const baseline = readAgentMessageCount(baselinePayload) ?? readAgentMessages(baselinePayload).length;

  // 送一輪（快回 accepted；確切 status/body 未實測，容忍 2xx 空 body）。
  const sent = await ctx.dispatcher({
    method: "POST",
    path: agentSessionPath(sessionId, "/messages"),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "run_agent",
    body: compact({ content: prompt, session_directive: directive }),
  });
  if (sent.status < 200 || sent.status >= 300) {
    return agentUpstreamFailure("POST", agentSessionPath(sessionId, "/messages"), sent);
  }

  // 輪詢：每 2s 一次簡化端點（絕不用 /messages——回包大又不保證 <10s）。
  let reply = "";
  let fresh: AgentMessage[] = [];
  for (;;) {
    const detail = await ctx.dispatcher({
      method: "GET",
      path: agentSessionPath(sessionId),
      authorization: ctx.authorization,
      traceId: ctx.traceId,
      toolName: "run_agent",
    });
    if (detail.status >= 200 && detail.status < 300) {
      const messages = readAgentMessages(parseJsonLoose(detail.text));
      fresh = baseline < messages.length ? messages.slice(baseline) : [];
      const assistant = fresh.filter((message) => message.role === "assistant" && message.text.trim() !== "");
      if (assistant.length > 0) {
        reply = assistant[assistant.length - 1].text;
        break;
      }
    }
    const remaining = deadlineAt - now();
    if (remaining <= 0) break;
    await sleep(Math.min(RUN_AGENT_POLL_INTERVAL_MS, remaining));
  }

  const completed = reply !== "";
  return textResult(
    JSON.stringify(
      {
        session_id: sessionId,
        status: completed ? "completed" : "running",
        reply,
        artifacts: extractAgentArtifacts(reply),
        ...(fresh.length > 0 ? { messages: fresh } : {}),
        elapsed_ms: now() - startedAt,
        ...(completed
          ? {}
          : {
              hint: `未在 ${timeoutSeconds}s 内等到回覆；任务可能仍在跑，用 get_agent_session（session_id=${sessionId}）续查。`,
            }),
      },
      null,
      2,
    ),
  );
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
    {
      name: "list_canvas_projects",
      title: "列出画布项目",
      description: bilingual(
        "列出本 API key 所属账号的畫布项目摘要（id／名称／创建与更新时间／节点数），按更新时间由新到旧。只回本密钥账号自己的项目，不回他人项目。拿到 project_id 后才能用 workflow_write 落图、用 workflow_rollback 回退——改画布产线前先调它找到目标项目。",
        "List canvas projects owned by the current API key's account (id, title, timestamps, node count). Use the returned id as project_id for workflow_write / workflow_rollback.",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) =>
        runForward({ method: "GET", path: "/api/v1/canvas/projects" }, "list_canvas_projects", args, ctx),
    },
    {
      name: "canvas_get_state",
      title: "读取画布快照",
      description: bilingual(
        "读取某个 agent 会话当前画布快照（节点/连线/选中/视口，以及画布产线的可逆声明 dsl 与节点版本索引 node_versions）。改动画布产线前先读它拿 session_id 对应的现状。会话无快照时上游回 has_state=false。",
        "Read the current canvas snapshot (nodes/connections/dsl/node_versions) of an agent session.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "agent 会话 id（画布由该会话持有）。" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) => runForward({ method: "GET", path: (a) => canvasStatePath(a) }, "canvas_get_state", args, ctx),
    },
    {
      name: "workflow_read",
      title: "读取工作流声明",
      description: bilingual(
        "读取画布产线的可逆声明（dsl = 工作流 DSL 源码数组）与当前节点版本索引，供「像改代码一样改工作流」：读 dsl → 改 steps → 用 workflow_write 整份交回。只投影 dsl 与版本索引，不含节点坐标。要完整画布用 canvas_get_state。",
        "Read the reversible workflow declarations (dsl) and node version index of an agent session's canvas.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "agent 会话 id（画布由该会话持有）。" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForwardProjected(
          { method: "GET", path: (a) => canvasStatePath(a) },
          "workflow_read",
          args,
          ctx,
          (payload) => {
            const state = snapshotState(payload);
            const p = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
            return {
              has_state: p.has_state === true,
              updated_at: p.updated_at ?? null,
              dsl: Array.isArray(state.dsl) ? state.dsl : [],
              workflow_versions: Array.isArray(state.node_versions) ? state.node_versions : [],
            };
          },
        ),
    },
    {
      name: "workflow_history",
      title: "读取工作流版本史",
      description: bilingual(
        "读取画布节点的版本史（node_versions：每节点的 version/created_at/reason/title）。给 node_id 只回该节点；拿 version 号去 workflow_rollback 回退。只回内容史（title+metadata），不含坐标。",
        "Read per-node version history from an agent session's canvas; pass node_id to filter one node.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "agent 会话 id（画布由该会话持有）。" },
          node_id: { type: "string", description: "只回该节点的版本史；省略回全部节点。" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForwardProjected(
          { method: "GET", path: (a) => canvasStatePath(a) },
          "workflow_history",
          args,
          ctx,
          (payload) => {
            const state = snapshotState(payload);
            const p = isPlainObject(payload) ? (payload as Record<string, unknown>) : {};
            const all = Array.isArray(state.node_versions) ? state.node_versions : [];
            const nodeId = pickString(args, "node_id");
            const versions = nodeId
              ? all.filter((entry) => isPlainObject(entry) && (entry as { node_id?: unknown }).node_id === nodeId)
              : all;
            return {
              has_state: p.has_state === true,
              node_id: nodeId ?? null,
              workflow_versions: versions,
            };
          },
        ),
    },
    {
      name: "workflow_write",
      title: "写入工作流声明",
      description: bilingual(
        "把整份工作流声明（DSL）编译成画布操作，落图与否看是否给了 project_id。用法：先 canvas_get_state / workflow_read 读 dsl，按需增删改 steps，整份 source 交回本工具。\n· 给了 project_id：编译后原子套用到该画布项目（B 端密钥所属账号的画布；跨账号的 project_id 找不到，画布不动）——这是外部 coding agent 端到端写产线的通道。\n· 没给 project_id：只编译，回 ops 与 summary（纯函数端点 /v1/workflow/compile）。\n校验失败一律回 workflow_dsl_invalid 与逐条 errors；同 id 同节点＝幂等更新（重放不重复建节点）。",
        "Compile a full workflow declaration (DSL) into canvas ops. With project_id it applies the ops atomically to that canvas project (owned by the key's account); without it, compile-only.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "object",
            description:
              "整份工作流声明：{ workflow, title?, steps: [{ id, title, kind?, prompt?, needs?, model?, size?, count?, gate?, tool?, meta? }] }（steps 1..24，从 dsl 读出后修改）。",
          },
          current: {
            type: "object",
            description: "画布当前真相 { nodes, connections }；省略＝用 project_id 项目的现况（推荐）或按空图编译。",
          },
          project_id: {
            type: "string",
            description: "画布项目 id（给了才真的套用到画布；项目必须属于本密钥账号）。",
          },
          dry_run: { type: "boolean", description: "true＝只编译回 ops 与 summary，不落图（给了 project_id 时可用）。" },
          label: { type: "string", description: "给用户看的一句话操作意图，如「把分镜从 3 步扩到 5 步」。" },
        },
        required: ["source"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            // 帶 project_id → 落圖端點（編譯＋套用到 owner 畫布）；不帶 → 既有純編譯端點。
            path: (a) => (pickString(a, "project_id") ? "/api/v1/canvas/workflow" : "/api/v1/workflow/compile"),
            body: (a) => {
              const projectId = pickString(a, "project_id");
              return projectId
                ? compact({ projectId, source: a.source, current: a.current, label: a.label, dry_run: a.dry_run })
                : compact({ source: a.source, current: a.current, label: a.label });
            },
          },
          "workflow_write",
          args,
          ctx,
        ),
    },
    {
      name: "workflow_rollback",
      title: "回滚工作流节点",
      description: bilingual(
        "把画布某个节点的内容回滚到指定版本（先 workflow_history 查 version）。version 省略＝回上一版；只还原内容（title+metadata），不动坐标/尺寸；回滚本身也落一版（reason=revert），可再回滚回去。要改出新内容用 workflow_write。走 B 端密钥鉴权的画布回退端点：project_id 所属项目必须在本密钥账号名下（跨账号的 project_id 一律拒绝，画布不动）。",
        "Roll a canvas node's content back to a version (or the previous one) via the B-key canvas revert endpoint; the project must belong to the key's account.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          node_id: { type: "string", description: "要回滚的节点 id（画布节点 id，如 wf-…）。" },
          project_id: { type: "string", description: "画布项目 id（node 所属 project）。" },
          version: { type: "integer", minimum: 1, description: "目标版本号；省略＝上一版。" },
        },
        required: ["node_id", "project_id"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: (a) => `/api/v1/canvas/nodes/${encodeURIComponent(pickString(a, "node_id") ?? "")}/revert`,
            body: (a) => compact({ projectId: a.project_id, version: a.version }),
          },
          "workflow_rollback",
          args,
          ctx,
        ),
    },
    {
      name: "list_agent_sessions",
      title: "列出 agent 会话",
      description: bilingual(
        "列出本 API key 所属账号的 Eimu agent 会话（session_id / status / title / updated_at），按最近活动由新到旧。这些会话与网页版 AI 助理是同一个账户空间（同一 settings）。拿到 session_id 后可用 get_agent_session 读对话与产物、用 run_agent 继续下任务。",
        "List Eimu agent sessions owned by the current API key's account (id / status / title / updated_at), newest first. Same account space as the web AI assistant.",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) =>
        runForwardProjected({ method: "GET", path: AGENT_SESSIONS_PATH }, "list_agent_sessions", args, ctx, (payload) => {
          const sessions = isPlainObject(payload) && Array.isArray(payload.sessions) ? payload.sessions : [];
          return {
            object: "agent.session.list",
            count: sessions.length,
            sessions: sessions.filter(isPlainObject).map((session) => ({
              session_id: session.session_id ?? null,
              status: session.status ?? null,
              title: session.title ?? null,
              updated_at: session.updated_at ?? null,
            })),
          };
        }),
    },
    {
      name: "get_agent_session",
      title: "读取 agent 会话",
      description: bilingual(
        "读取一个 Eimu agent 会话的内容：view=summary（默认，会话摘要与消息计数）、view=transcript（角色/部件级对话）、view=raw（网关原始消息，体积大）。assistant 的最终文字里含成品图片/影片 URL（用 run_agent 也可直接拿到结构化 artifacts）。会话属于本密钥账号，跨账号一律找不到。",
        "Read one Eimu agent session: view=summary (default) | transcript | raw. The assistant's final text carries finished image/video URLs.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "agent 会话 id（来自 list_agent_sessions）。" },
          view: {
            type: "string",
            enum: ["summary", "transcript", "raw"],
            description: "视图：summary（默认）| transcript | raw。",
          },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) => {
        const view = pickString(args, "view") ?? "summary";
        const path = (a: Record<string, unknown>) => {
          const id = encodeURIComponent(pickString(a, "session_id") ?? "");
          if (view === "transcript") return `${AGENT_SESSIONS_PATH}/${id}/transcript`;
          if (view === "raw") return `${AGENT_SESSIONS_PATH}/${id}/messages`;
          return `${AGENT_SESSIONS_PATH}/${id}`;
        };
        return runForward({ method: "GET", path }, "get_agent_session", args, ctx);
      },
    },
    {
      name: "get_agent_settings",
      title: "读取 agent 设置",
      description: bilingual(
        "读取本 API key 所属账号的 Eimu agent 设置（interrupt_mode / persona / cost_mode / interaction_mode / beast_mode）。beast_mode（野獸模式）是账号级开关，由 agent orchestrator 即时读取；本工具纯读，不产生费用。",
        "Read the account-level Eimu agent settings (including beast_mode). Read-only, no charge.",
      ),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: (args, ctx) =>
        runForward({ method: "GET", path: AGENT_SETTINGS_PATH }, "get_agent_settings", args, ctx),
    },
    {
      name: "run_agent",
      title: "运行 agent 任务",
      description: bilingual(
        "把一个任务交给 Eimu 的 agent orchestrator 执行，返回最终回复与成品 URL（artifacts）。注意：这会真实消耗账号额度——orchestrator 会依任务自行使用生成类工具（可能扣费）；纯文本问答不要用它。它会自动建会话（或续用你给的 session_id）、快回 accepted 后由本工具反复轮询取结果；超时返回 status=running，可用 get_agent_session 续查。",
        "Hand a task to Eimu's agent orchestrator and return its final reply plus artifact URLs. This really consumes account credits because the orchestrator may call billed generation tools itself; do not use it for plain text Q&A.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "任务指令，必填，最长 8000 字符。" },
          session_id: { type: "string", description: "续用既有会话；省略则新建一个会话。" },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: RUN_AGENT_MAX_TIMEOUT_SECONDS,
            description: `等待上限（秒），默认 ${RUN_AGENT_DEFAULT_TIMEOUT_SECONDS}，上限 ${RUN_AGENT_MAX_TIMEOUT_SECONDS}。`,
          },
          session_directive: { type: "string", description: "本次会话的额外指令（可选，最长 4000 字符）。" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      run: (args, ctx) => runAgent(args, ctx),
    },
    {
      name: "abort_agent_session",
      title: "中止 agent 会话",
      description: bilingual(
        "中止一个正在运行的 Eimu agent 会话（中断当前回合）。会话必须属于本密钥账号；上游回包原样返回。",
        "Abort a running Eimu agent session (interrupt the current turn); returns the upstream response verbatim.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "要中止的 agent 会话 id。" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          { method: "POST", path: (a) => agentSessionPath(pickString(a, "session_id") ?? "", "/abort"), body: () => ({}) },
          "abort_agent_session",
          args,
          ctx,
        ),
    },
    // ─────────────────────────────────────────── 閘門工具（2026-10-03 MCP 暴露）
    //
    // 這兩支是給外部 agent 對**自己的產物**做確定性自檢的閘門：不重寫任何業務，
    // 只把參數原樣交給站內 `/api/harness/**` 端點（契約校驗真源＝expert-contract.ts，
    // 媒體硬檢真源＝media-quality-gate.ts），回包原樣透傳。
    // 刻意**不**放在 `/api/v1/**`：該前綴被 next.config.mjs 的 beforeFiles 整包代理給控面，
    // 控面沒有這兩條 route ⇒ 直打會 404（2026-10-03 線上缺陷）。`/api/harness/**` 未被代理，
    // 由本 Vercel 部署直接服務。漂移探針見 tools.test.ts 的「MCP 工具目標路由漂移」。
    {
      name: "check_delivery_contract",
      title: "校验交付契约",
      description: bilingual(
        "对 Expert 交付物做**契约栏位层**的确定性校验，逐条检查：① expert_id 是合法 Expert；② kind 非空、payload 是非空物件；③ evidence 至少一项可核验指针（url／artifact_path／bytes／duration_sec 任一非空）；④ qc_signature 与内容相符（computeQcSignature 重算比对）；⑤ **该域契约的必填栏位每一栏在 payload 中必须存在且值非空**（undefined／null／空字符串／空白字符串／空数组／空对象一律算缺，缺栏按契约顺序点名）。**这不是品质评分**——它不判断作品好不好，只判断交付物合不合契约；ok:true 只代表「栏位层合格」，不代表成品可用（成品品质请用 evaluate_media_quality）。注意：站内还有一个同名交付闸门，但判据不同——它是在**自由文本**里做栏位名子字符串命中（栏名出现即算过，空值也命中），本工具是**结构化物件**检查（栏位必须在 payload 里且值非空），两者读同一份契约档但**判据不等价**。返回 { ok, errors[], qc_signature }：qc_signature 恒回对本次输入重算出的**期望值**（sha256 校验和，无密钥、无秘密），便于修正或比对。",
        "Deterministic contract-field validation of an Expert deliverable. It checks: (1) expert_id is a known Expert; (2) kind non-empty and payload is a non-empty object; (3) evidence has at least one verifiable pointer (url/artifact_path/bytes/duration_sec); (4) qc_signature matches the content (recomputed via computeQcSignature); (5) **every required field of that domain's contract exists in payload with a non-empty value** (undefined/null/empty or whitespace string/empty array/empty object all count as missing, and missing ones are named in contract order). This is NOT a quality score: ok:true means the contract shape is valid, not that the artifact is good — use evaluate_media_quality for the artifact. Note the in-house gate of the same name has DIFFERENT criteria: it does substring matching of field NAMES in free text (a name's presence passes even with an empty value), whereas this tool inspects a structured object (the field must exist in payload with a non-empty value); both read the same contract file but the criteria are NOT equivalent. Returns { ok, errors[], qc_signature } where qc_signature is always the expected checksum recomputed over the submitted input (sha256, no key, no secret).",
      ),
      inputSchema: {
        type: "object",
        properties: {
          expert_id: {
            type: "string",
            enum: EXPERT_IDS,
            description: "Expert 身份 id（决定允许的交付域与该域的必填契约栏位）。",
          },
          kind: {
            type: "string",
            description: "交付物种类（如 scene_3d / music_track）。",
          },
          payload: {
            type: "object",
            description: "交付物本体（按域 schema；必须含该域契约 requiredFields 的每一栏且值非空）。",
          },
          evidence: {
            type: "object",
            description: bilingual(
              "可核验指针，至少一项非空。**键名两种拼法都接受**：snake_case（`artifact_path`／`duration_sec`）与 camelCase（`artifactPath`／`durationSec`）皆可，**两者同时给时以 camelCase 为准**；`url`／`bytes` 本就同名。",
              "Verifiable pointer, at least one non-empty. BOTH key spellings are accepted: snake_case (`artifact_path`/`duration_sec`) and camelCase (`artifactPath`/`durationSec`); when both are given, camelCase takes precedence. `url`/`bytes` are identical in both spellings.",
            ),
          },
          qc_signature: {
            type: "string",
            description: "QC 签名（computeQcSignature 产出的 sha256 hex）；缺或不符会随 errors 一并回报期望值。",
          },
        },
        required: ["expert_id", "kind", "payload"],
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: "/api/harness/expert/deliverable/validate",
            body: (a) =>
              compact({
                expert_id: a.expert_id,
                kind: a.kind,
                payload: a.payload,
                evidence: a.evidence,
                qc_signature: a.qc_signature,
              }),
          },
          "check_delivery_contract",
          args,
          ctx,
        ),
    },
    {
      name: "evaluate_media_quality",
      title: "媒体硬检",
      description: bilingual(
        "对已生成完成的影片/图片/音频做确定性硬检（分辨率/时长/文件大小/音轨/非静音等），套用我方政策阈值。三条诚实契约：① 量测在**我们的服务器**上执行（本机 ffprobe/ffmpeg）；本部署环境（Vercel serverless）**不保证有 ffprobe/ffmpeg**，量测失败会**原样回** { ok:false, failures:[{ code:\"probe_unavailable\" }] }——**probe_unavailable ≠ 通过**，它代表「量测没有发生」，不是「检查通过」；② 呼叫方也可以自己 ffprobe 后把 probe 传进来，我们只负责套用**我们的政策与阈值**；③ 给了 probe 就不再执行服务器量测。返回 { ok, failures[], measured, policyId }。",
        "Deterministic hard check of a finished video/image/audio against our policy thresholds. Honesty contract: measurement runs on OUR server and this deployment (Vercel serverless) may lack ffprobe/ffmpeg, in which case it returns ok:false with a probe_unavailable failure — probe_unavailable is NOT a pass, it means nothing was measured. Alternatively pass your own ffprobe `probe` and we only apply our policy/thresholds. Returns { ok, failures[], measured, policyId }.",
      ),
      inputSchema: {
        type: "object",
        properties: {
          media_url: {
            type: "string",
            description: "要量测的媒体地址（http(s) URL）或服务器可读路径；省略时必须给 probe。",
          },
          probe: {
            type: "object",
            description:
              "呼叫方自行 ffprobe 的结果（MediaProbe 形状：status / container / durationSec / sizeBytes / video / audio）；给了它我们只套政策，不做服务器量测。",
          },
          policy: {
            type: "string",
            enum: QUALITY_POLICY_IDS,
            description: `政策 id，默认 video_default（可选：${QUALITY_POLICY_IDS.join(" / ")}）。`,
          },
        },
        additionalProperties: false,
      },
      run: (args, ctx) =>
        runForward(
          {
            method: "POST",
            path: "/api/harness/media/quality",
            body: (a) => compact({ media_url: a.media_url, probe: a.probe, policy: a.policy }),
          },
          "evaluate_media_quality",
          args,
          ctx,
        ),
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
