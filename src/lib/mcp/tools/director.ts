/**
 * 导演入口：eimu_direct / eimu_job。
 *
 * - 有界等待默认 ≤45s；超时回 processing + job_id + poll_after_seconds，明说勿重提交。
 * - 完成判定走网关会话运行态（status idle|running|waiting），不是「第一条 assistant 文本」。
 * - 花费闸：preflight / mode=quote 只报价；正式跑须 budget_cap 或 confirm=true。
 * - 产物 structuredContent 分类 film/storyboard/brief/bible/keyframes/stills/audio（stills＝非分镜板的成品静帧，如电商主图／卖点／细节；label 保留回覆原标签）。
 * job_id 当前等价于 agent session_id（与 biz 闸道同一身分空间）。
 */

import { machineError, structuredResult, type McpToolCallResult } from "../protocol";
import {
  agentSessionPath,
  collectClassifiedArtifacts,
  DIRECTOR_ARTIFACT_CATEGORIES,
  type DirectorArtifactCategory,
} from "./agent";
import {
  AGENT_SESSIONS_PATH,
  EIMU_DIRECT_DEFAULT_WAIT_SECONDS,
  EIMU_DIRECT_MAX_WAIT_SECONDS,
  EIMU_DIRECTOR_POLL_INTERVAL_MS,
  EIMU_IDLE_CLAIM_STALL_MS,
  EIMU_JOB_DEFAULT_WAIT_SECONDS,
  EIMU_JOB_MAX_WAIT_SECONDS,
  EIMU_POLL_AFTER_SECONDS,
  EIMU_QUOTE_ESTIMATE_COINS,
  EIMU_QUOTE_PLACEHOLDER_LABEL,
  EIMU_QUOTE_TYPICAL_IMAGES,
  MODELS_PATH,
  QUOTA_PATH,
} from "./constants";
import { bilingual, compact, pickString } from "./helpers";
import { BEAST_MODE_SCHEMA, THINKING_LEVEL_SCHEMA, buildAgentSettingsPatch, postAgentSettings } from "./settings";
import type { McpDispatchResponse, McpToolContext, ToolDefinition } from "./types";
import { isPlainObject } from "./validation";

type SessionRuntimeStatus = "idle" | "running" | "waiting";
type DirectorMode = "quote" | "plan" | "full";
type JobAction = "get" | "wait" | "reply" | "approve" | "reject" | "revise" | "cancel";

/**
 * 网关 GET /sessions/:id/status 的 pending_confirm_items 一项（照抄网关契约：
 * request_id / charge / amount_coins / model / task_id / description；charge=false 为非扣费闸）。
 * 对外以 id 暴露，id 即网关 request_id，可直接喂给 eimu_job approve|reject 的 confirm_ids。
 */
interface PendingConfirmItem {
  id: string;
  charge: boolean;
  amount_coins: number | null;
  model: string | null;
  task_id: string | null;
  description: string | null;
}

interface AutoApprovedItem {
  id: string;
  amount_coins: number | null;
  model: string | null;
  description: string | null;
}

/** 照抄网关 pending_question_items 契约（H11）。answers 依 questions 顺序作答。 */
interface PendingQuestionItem {
  request_id: string;
  questions: Array<{
    header: string | null;
    question: string;
    options: Array<{ label: string; description: string | null }>;
  }>;
}

interface JobRuntime {
  status: SessionRuntimeStatus;
  phase: string;
  pending_questions: number;
  pending_confirms: number;
  /** null＝旧网关没投影（不可据此判空闲）。 */
  active_children: number | null;
  inflight_generations: number | null;
  /** null＝旧网关没投影确认卡明细（无法按 id 批准）。 */
  pending_confirm_items: PendingConfirmItem[] | null;
  /** null＝旧网关没投影 question 明细。 */
  pending_question_items: PendingQuestionItem[] | null;
  recent_approved_coins: number | null;
  last_activity_at: number | null;
  source: "status_endpoint" | "session_list" | "assumed_running";
  detail?: unknown;
}

interface AgentMessage {
  role: string;
  text: string;
}

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

function readAgentMessages(payload: unknown): AgentMessage[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.messages)) return [];
  const out: AgentMessage[] = [];
  for (const entry of payload.messages) {
    if (!isPlainObject(entry)) continue;
    out.push({
      role: typeof entry.role === "string" ? entry.role : "",
      text: typeof entry.text === "string" ? entry.text : "",
    });
  }
  return out;
}

function readAgentMessageCount(payload: unknown): number | null {
  if (!isPlainObject(payload)) return null;
  const count = payload.message_count;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

function clampWaitSeconds(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

function normalizeMode(raw: unknown): DirectorMode {
  if (raw === "quote" || raw === "plan" || raw === "full") return raw;
  return "full";
}

function normalizeAction(raw: unknown): JobAction {
  if (
    raw === "get" ||
    raw === "wait" ||
    raw === "reply" ||
    raw === "approve" ||
    raw === "reject" ||
    raw === "revise" ||
    raw === "cancel"
  ) {
    return raw;
  }
  return "get";
}

/**
 * 计费通道故障判定（不是余额不足）：402/503 回包带 billing_relay_unavailable／DEPLOYMENT_DISABLED／「计费通道故障」字样，
 * 或 402 回包根本不是 JSON（中继部署被停用时 Vercel 回的纯文本错误页）。
 */
function isBillingRelayFailure(response: McpDispatchResponse): boolean {
  if (response.status !== 402 && response.status !== 503) return false;
  const text = response.text ?? "";
  if (/billing_relay_unavailable|DEPLOYMENT_DISABLED|计费通道故障/i.test(text)) return true;
  return response.status === 402 && parseJsonLoose(text) === undefined;
}

function upstreamFailure(method: string, path: string, response: McpDispatchResponse): McpToolCallResult {
  if (isBillingRelayFailure(response)) {
    return machineError({
      code: "billing_relay_unavailable",
      message: `上游 ${method} ${path} 回 HTTP ${response.status}：计费通道故障（非余额不足，勿充值），请稍后重试。`,
      retryable: true,
      next_action: "retry_later",
      http_status: response.status,
      body_excerpt: response.text.slice(0, 800),
    });
  }
  return machineError({
    code: "upstream_http_error",
    message: `上游 ${method} ${path} 回应 HTTP ${response.status}`,
    retryable: response.status >= 500 || response.status === 429,
    next_action: response.status === 401 || response.status === 403 ? "check_api_key" : "retry_later",
    http_status: response.status,
    body_excerpt: response.text.slice(0, 800),
  });
}

async function fetchQuotaCoins(ctx: McpToolContext, toolName: string): Promise<{
  balance_coins: number | null;
  currency: string | null;
  error?: McpToolCallResult;
}> {
  const response = await ctx.dispatcher({
    method: "GET",
    path: QUOTA_PATH,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
  });
  if (response.status < 200 || response.status >= 300) {
    return { balance_coins: null, currency: null, error: upstreamFailure("GET", QUOTA_PATH, response) };
  }
  const payload = parseJsonLoose(response.text);
  if (!isPlainObject(payload)) return { balance_coins: null, currency: null };
  const balance = payload.balance_coins;
  return {
    balance_coins: typeof balance === "number" && Number.isFinite(balance) ? balance : null,
    currency: typeof payload.currency === "string" ? payload.currency : "coins",
  };
}

interface ImagePriceTable {
  median_coins_per_image: number;
  image_models: number;
}

function roundCoins(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 读价目表（GET /api/v1/models，与 list_models 同源）：图像模型 x_coins_per_image.standard 的中位数。失败回 null。 */
async function fetchImagePriceTable(ctx: McpToolContext, toolName: string): Promise<ImagePriceTable | null> {
  const response = await ctx.dispatcher({
    method: "GET",
    path: MODELS_PATH,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
  });
  if (response.status < 200 || response.status >= 300) return null;
  const payload = parseJsonLoose(response.text);
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) return null;
  const prices: number[] = [];
  for (const entry of payload.data) {
    if (!isPlainObject(entry) || !isPlainObject(entry.x_coins_per_image)) continue;
    const standard = entry.x_coins_per_image.standard;
    if (typeof standard === "number" && Number.isFinite(standard) && standard > 0) prices.push(standard);
  }
  if (prices.length === 0) return null;
  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 1 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  return { median_coins_per_image: roundCoins(median), image_models: prices.length };
}

/**
 * 报价：mode=quote 报的是「正式 full 跑」的花费（只报价本身当然 0 币，回 0 没有意义）。
 * full：价目表中位单价 × 典型张数（标注来源）；读不到价目表或 plan：常数占位（明标）。
 */
function buildQuotePayload(
  mode: DirectorMode,
  balanceCoins: number | null,
  currency: string | null,
  priceTable: ImagePriceTable | null,
) {
  const quotedMode: Exclude<DirectorMode, "quote"> = mode === "quote" ? "full" : mode;
  const typicalImages = EIMU_QUOTE_TYPICAL_IMAGES[quotedMode];
  let estimated: number;
  let estimateSource: string;
  if (typicalImages > 0 && priceTable) {
    estimated = roundCoins(priceTable.median_coins_per_image * typicalImages);
    estimateSource =
      `价目表 GET ${MODELS_PATH}：${priceTable.image_models} 个图像模型 standard 单价中位数 ` +
      `${priceTable.median_coins_per_image} 币 × ${quotedMode} 典型 ${typicalImages} 张`;
  } else {
    estimated = EIMU_QUOTE_ESTIMATE_COINS[quotedMode];
    estimateSource =
      typicalImages > 0
        ? `${EIMU_QUOTE_PLACEHOLDER_LABEL}（未读到价目表，回落固定 ${estimated} 币）`
        : `${EIMU_QUOTE_PLACEHOLDER_LABEL}（${quotedMode} 只出方案不出图，固定 ${estimated} 币）`;
  }
  const affordable = balanceCoins === null ? null : balanceCoins >= estimated;
  return {
    mode,
    quoted_mode: quotedMode,
    estimated_coins: estimated,
    estimate_source: estimateSource,
    typical_images: typicalImages,
    balance_coins: balanceCoins,
    currency: currency ?? "coins",
    affordable,
    note: "粗估，非计费真源；不含视频／音频与重试，极限模式可能更多；正式扣费以帐本为准。quote/preflight 不扣费。",
  };
}

function emptyArtifacts(): Record<DirectorArtifactCategory, Array<{ url: string; mime: string; label: string }>> {
  return Object.fromEntries(DIRECTOR_ARTIFACT_CATEGORIES.map((c) => [c, []])) as unknown as Record<
    DirectorArtifactCategory,
    Array<{ url: string; mime: string; label: string }>
  >;
}

function slimArtifacts(classified: ReturnType<typeof collectClassifiedArtifacts>) {
  const out = emptyArtifacts();
  for (const key of Object.keys(out) as DirectorArtifactCategory[]) {
    out[key] = classified[key].map((item) => ({
      url: item.url,
      mime: item.mime,
      label: item.label,
    }));
  }
  return out;
}

function latestAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant" && messages[i].text.trim() !== "") return messages[i].text;
  }
  return "";
}

function parseRuntimeStatus(raw: unknown): SessionRuntimeStatus | null {
  if (raw === "idle" || raw === "running" || raw === "waiting") return raw;
  return null;
}

/** 优先 GET /sessions/:id/status；缺接口时回落列表 status。 */
function finiteOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** 照抄网关 pending_confirm_items 契约；栏位缺失（旧网关）回 null。 */
function readPendingConfirmItems(raw: unknown): PendingConfirmItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PendingConfirmItem[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.request_id === "string" ? entry.request_id : "";
    if (!id) continue;
    out.push({
      id,
      charge: entry.charge === true,
      amount_coins: finiteOrNull(entry.amount_coins),
      model: typeof entry.model === "string" ? entry.model : null,
      task_id: typeof entry.task_id === "string" ? entry.task_id : null,
      description: typeof entry.description === "string" ? entry.description : null,
    });
  }
  return out;
}

function readPendingQuestionItems(raw: unknown): PendingQuestionItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PendingQuestionItem[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry) || typeof entry.request_id !== "string" || !entry.request_id) continue;
    const questions = Array.isArray(entry.questions) ? entry.questions : [];
    out.push({
      request_id: entry.request_id,
      questions: questions.filter(isPlainObject).map((q) => ({
        header: typeof q.header === "string" ? q.header : null,
        question: typeof q.question === "string" ? q.question : "",
        options: (Array.isArray(q.options) ? q.options : []).filter(isPlainObject).map((o) => ({
          label: typeof o.label === "string" ? o.label : "",
          description: typeof o.description === "string" ? o.description : null,
        })),
      })),
    });
  }
  return out;
}

/** 网关 QUESTION_ASSUME_MS 默认 180s：question 卡超时即 expired_without_consent，不代答。 */
const QUESTION_EXPIRY_NOTE =
  "导演用 question 卡请示：请把 questions 原样转给用户，约 3 分钟内用 eimu_job reply（answers 依题序给选项 label，或 message 作为自由回答）作答；超时网关按「超时未回复」拒绝，导演会停下。";

/** awaiting_input 附带的提问明细（无 question 时不加栏位）。 */
function questionFields(runtime: JobRuntime): Record<string, unknown> {
  if (runtime.pending_questions <= 0) return {};
  if (runtime.pending_question_items === null) {
    return { questions: null, questions_note: "网关未投影 question 明细（旧版）；题面见网页，或用 eimu_job reply 的 message 自由作答。" };
  }
  return { questions: runtime.pending_question_items, questions_note: QUESTION_EXPIRY_NOTE };
}

async function resolveJobRuntime(jobId: string, ctx: McpToolContext, toolName: string): Promise<JobRuntime> {
  const statusPath = agentSessionPath(jobId, "/status");
  const statusRes = await ctx.dispatcher({
    method: "GET",
    path: statusPath,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
  });
  if (statusRes.status >= 200 && statusRes.status < 300) {
    const payload = parseJsonLoose(statusRes.text);
    if (isPlainObject(payload)) {
      const status = parseRuntimeStatus(payload.status) ?? "idle";
      return {
        status,
        phase: typeof payload.phase === "string" ? payload.phase : status,
        pending_questions: typeof payload.pending_questions === "number" ? payload.pending_questions : 0,
        pending_confirms: typeof payload.pending_confirms === "number" ? payload.pending_confirms : 0,
        active_children: finiteOrNull(payload.active_children),
        inflight_generations: finiteOrNull(payload.inflight_generations),
        pending_confirm_items: readPendingConfirmItems(payload.pending_confirm_items),
        pending_question_items: readPendingQuestionItems(payload.pending_question_items),
        recent_approved_coins: finiteOrNull(payload.recent_approved_coins),
        last_activity_at: finiteOrNull(payload.last_activity_at),
        source: "status_endpoint",
        detail: payload,
      };
    }
  }

  const listRes = await ctx.dispatcher({
    method: "GET",
    path: AGENT_SESSIONS_PATH,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
  });
  if (listRes.status >= 200 && listRes.status < 300) {
    const payload = parseJsonLoose(listRes.text);
    const sessions = isPlainObject(payload) && Array.isArray(payload.sessions) ? payload.sessions : [];
    for (const entry of sessions) {
      if (!isPlainObject(entry)) continue;
      if (entry.session_id !== jobId) continue;
      const status = parseRuntimeStatus(entry.status) ?? "idle";
      return {
        status,
        phase: status,
        pending_questions: 0,
        pending_confirms: 0,
        active_children: null,
        inflight_generations: null,
        pending_confirm_items: null,
        pending_question_items: null,
        recent_approved_coins: null,
        last_activity_at: null,
        source: "session_list",
        detail: entry,
      };
    }
  }

  // 刚提交、列表尚未出现时：保守当作 running，避免误报 completed。
  return {
    status: "running",
    phase: "running",
    pending_questions: 0,
    pending_confirms: 0,
    active_children: null,
    inflight_generations: null,
    pending_confirm_items: null,
    pending_question_items: null,
    recent_approved_coins: null,
    last_activity_at: null,
    source: "assumed_running",
  };
}

async function fetchSessionDetail(jobId: string, ctx: McpToolContext, toolName: string): Promise<{
  messages: AgentMessage[];
  message_count: number;
  raw?: unknown;
  error?: McpToolCallResult;
}> {
  const detail = await ctx.dispatcher({
    method: "GET",
    path: agentSessionPath(jobId),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
  });
  if (detail.status < 200 || detail.status >= 300) {
    return { messages: [], message_count: 0, error: upstreamFailure("GET", agentSessionPath(jobId), detail) };
  }
  const payload = parseJsonLoose(detail.text);
  const messages = readAgentMessages(payload);
  return {
    messages,
    message_count: readAgentMessageCount(payload) ?? messages.length,
    raw: payload,
  };
}

function buildDirectorPrompt(
  args: Record<string, unknown>,
  mode: DirectorMode,
  budgetCap: number | null,
  baselineBalance: number | null,
): {
  content: string;
  session_directive?: string;
} {
  const prompt = pickString(args, "prompt") ?? "";
  const refs = Array.isArray(args.reference_urls)
    ? args.reference_urls.filter((u): u is string => typeof u === "string" && u.trim() !== "").slice(0, 8)
    : [];
  const lines = [
    mode === "plan" ? "【模式=plan】只出方案／brief／分镜计划，不要开拍成片。" : "【模式=full】按导演全链路推进到成片。",
    pickString(args, "aspect_ratio") ? `画幅：${pickString(args, "aspect_ratio")}` : "",
    typeof args.duration_seconds === "number" ? `目标时长：${args.duration_seconds}s` : "",
    pickString(args, "style") ? `风格：${pickString(args, "style")}` : "",
    budgetCap !== null ? `预算上限：${budgetCap} 币（超预算先停下来问用户，勿静默超支）。` : "",
    // MCP 预算记账基线（eimu_job 轮询自动批准时由此推算累计花费；不新增存储）。
    budgetCap !== null && baselineBalance !== null ? `预算基线：开拍前余额 ${baselineBalance} 币。` : "",
    refs.length > 0 ? `参考素材 URL：\n${refs.map((u) => `- ${u}`).join("\n")}` : "",
    "",
    prompt,
  ].filter((line, idx, arr) => line !== "" || (idx > 0 && arr[idx - 1] !== ""));

  const directiveBits = [
    mode === "plan" ? "director_mode=plan" : "director_mode=full",
    budgetCap !== null ? `budget_cap=${budgetCap}` : "",
  ].filter(Boolean);

  return {
    content: lines.join("\n").trim(),
    session_directive: directiveBits.length > 0 ? directiveBits.join("; ") : undefined,
  };
}

function okResult(summary: string, structured: Record<string, unknown>): McpToolCallResult {
  return structuredResult(`${summary}\n\n${JSON.stringify(structured, null, 2)}`, structured);
}

async function ensureSession(args: Record<string, unknown>, ctx: McpToolContext, toolName: string): Promise<
  { sessionId: string } | { error: McpToolCallResult }
> {
  let sessionId = pickString(args, "session_id") ?? "";
  if (sessionId) return { sessionId };
  const created = await ctx.dispatcher({
    method: "POST",
    path: AGENT_SESSIONS_PATH,
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
    body: {},
  });
  if (created.status < 200 || created.status >= 300) {
    return { error: upstreamFailure("POST", AGENT_SESSIONS_PATH, created) };
  }
  sessionId = extractSessionId(parseJsonLoose(created.text)) ?? "";
  if (!sessionId) {
    return {
      error: machineError({
        code: "session_create_failed",
        message: "建立 agent 会话失败：上游回包没有 session_id",
        retryable: true,
        next_action: "retry_or_list_agent_sessions",
      }),
    };
  }
  return { sessionId };
}

// ── 完成闸：主回合 idle ≠ 任务完成 ───────────────────────────────────────────

/** 回覆声称「还在跑」的措辞（产物为空时出现即不判 completed）。 */
const IN_PROGRESS_CLAIM_RE =
  /正在(?:并行|批量)?(?:生成|出图|渲染|制作|处理|跑)|生成中|渲染中|排队中|并行(?:生成|出图|跑)|(?:现在)?派出(?:了)?(?:生成|子代理)|已派(?:出|遣)|两路已经派|子代理[^。\n]{0,12}(?:在跑|执行中|进行中|生成)|稍等|稍候|请等待|跑完(?:后|再)|in progress|still generating/i;

function artifactCount(artifacts: ReturnType<typeof slimArtifacts>): number {
  return Object.values(artifacts).reduce((sum, list) => sum + list.length, 0);
}

type IdleGate =
  | { kind: "done" }
  | { kind: "busy"; reason: string }
  | { kind: "stalled"; reason: string };

/**
 * 会话 idle 时是否真的完成：
 * - 网关投影 active_children／inflight_generations 任一 >0 ⇒ busy（后台子代理／生成仍在跑）；
 * - 产物为空且无助手摘要 ⇒ busy（启动／回合间隙竞态；久无活动 ⇒ stalled）；
 * - 产物为空且最新回覆声称还在生成 ⇒ busy；距 last_activity_at 超过 EIMU_IDLE_CLAIM_STALL_MS ⇒ stalled；
 * - 否则 done。旧网关（无投影）靠后两条兜底。
 */
function idleGate(runtime: JobRuntime, summary: string, artifacts: ReturnType<typeof slimArtifacts>, nowMs: number): IdleGate {
  if ((runtime.active_children ?? 0) > 0) return { kind: "busy", reason: `active_children=${runtime.active_children}` };
  if ((runtime.inflight_generations ?? 0) > 0) {
    return { kind: "busy", reason: `inflight_generations=${runtime.inflight_generations}` };
  }
  const emptyArtifacts = artifactCount(artifacts) === 0;
  // 启动／回合间隙竞态：idle + 无产物 + 无助手摘要 ≠ 完成（2026-11-02 真路径：wait 45s 空 completed，随后才 fork 子代理）。
  if (emptyArtifacts && !summary.trim()) {
    if (runtime.last_activity_at !== null && nowMs - runtime.last_activity_at > EIMU_IDLE_CLAIM_STALL_MS) {
      return { kind: "stalled", reason: "idle_empty_no_assistant_summary" };
    }
    return { kind: "busy", reason: "idle_empty_no_assistant_summary" };
  }
  if (emptyArtifacts && IN_PROGRESS_CLAIM_RE.test(summary)) {
    if (runtime.last_activity_at !== null && nowMs - runtime.last_activity_at > EIMU_IDLE_CLAIM_STALL_MS) {
      return { kind: "stalled", reason: "idle_claims_in_progress_without_artifacts" };
    }
    return { kind: "busy", reason: "claims_in_progress_without_artifacts" };
  }
  return { kind: "done" };
}

function confirmCards(runtime: JobRuntime): PendingConfirmItem[] | null {
  return runtime.pending_confirm_items;
}

// ── 确认卡：与前端 resolveAgentConfirm 同一端点同一 body ─────────────────────

interface ConfirmResult {
  id: string;
  outcome: "approved" | "rejected" | "expired" | "error";
  http_status: number;
}

/** POST /sessions/:id/confirm {request_id, approved}（照抄 src/lib/agent-chat-client/session.ts resolveAgentConfirm）。 */
async function postConfirm(
  jobId: string,
  requestId: string,
  approved: boolean,
  ctx: McpToolContext,
  toolName: string,
): Promise<ConfirmResult> {
  const response = await ctx.dispatcher({
    method: "POST",
    path: agentSessionPath(jobId, "/confirm"),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName,
    body: { request_id: requestId, approved },
  });
  if (response.status >= 200 && response.status < 300) {
    return { id: requestId, outcome: approved ? "approved" : "rejected", http_status: response.status };
  }
  // 网关 handleConfirm：未知／已过期 request_id 回 404 confirm_expired。
  if (response.status === 404) return { id: requestId, outcome: "expired", http_status: 404 };
  return { id: requestId, outcome: "error", http_status: response.status };
}

// ── 预算自动批准（budget_cap）────────────────────────────────────────────────

interface BudgetLedger {
  cap: number | null;
  baseline: number | null;
}

/** 从会话里 eimu_direct 写入的使用者讯息解析预算上限／基线（取最后一次出现；不新增存储）。 */
function parseBudgetLedger(messages: AgentMessage[]): BudgetLedger {
  let cap: number | null = null;
  let baseline: number | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const capMatch = /预算上限[:：]\s*(\d+(?:\.\d+)?)\s*币/.exec(message.text);
    if (capMatch) cap = Number(capMatch[1]);
    const baseMatch = /预算基线[:：]\s*开拍前余额\s*(-?\d+(?:\.\d+)?)\s*币/.exec(message.text);
    if (baseMatch) baseline = Number(baseMatch[1]);
  }
  return { cap, baseline };
}

interface AutoApproveState {
  approved: AutoApprovedItem[];
  attempted: Set<string>;
}

interface AutoApproveOutcome {
  approvedNow: number;
  exceeded: Array<PendingConfirmItem & { reason: string }>;
  /** 自动批准之后仍需人处理的卡数（非扣费闸＋超额卡）。 */
  remaining: number;
  budget?: Record<string, unknown>;
  skipped?: string;
}

/**
 * 轮询时在 budget_cap 内自动批准扣费确认卡（单卡 ≤ cap 且累计 ≤ cap）。
 * 累计花费＝max(0, 开拍前余额 − 当前余额) ＋ 网关近 5 分钟已批准金额 ＋ 本次已批准金额——
 * 会重复计入（已扣的也在 recent 里）、也会计入同帐号其他会话花费，属保守上界：只会提早停，不会超支。
 */
async function autoApproveWithinBudget(
  jobId: string,
  runtime: JobRuntime,
  messages: AgentMessage[],
  ctx: McpToolContext,
  toolName: string,
  state: AutoApproveState,
): Promise<AutoApproveOutcome> {
  const items = runtime.pending_confirm_items;
  if (!items) return { approvedNow: 0, exceeded: [], remaining: runtime.pending_confirms, skipped: "confirm_items_unavailable" };
  const ledger = parseBudgetLedger(messages);
  const charge = items.filter((item) => item.charge && !state.attempted.has(item.id));
  const nonCharge = items.filter((item) => !item.charge);
  if (ledger.cap === null) return { approvedNow: 0, exceeded: [], remaining: items.length, skipped: "no_budget_cap" };
  if (charge.length === 0) return { approvedNow: 0, exceeded: [], remaining: items.length, skipped: "no_charge_cards" };
  if (ledger.baseline === null) {
    return { approvedNow: 0, exceeded: [], remaining: items.length, skipped: "no_budget_baseline" };
  }
  const quota = await fetchQuotaCoins(ctx, toolName);
  if (quota.balance_coins === null) {
    return { approvedNow: 0, exceeded: [], remaining: items.length, skipped: "balance_unavailable" };
  }
  const spentByBalance = Math.max(0, ledger.baseline - quota.balance_coins);
  const recent = runtime.recent_approved_coins ?? 0;
  const thisCall = state.approved.reduce((sum, item) => sum + (item.amount_coins ?? 0), 0);
  let committed = roundCoins(spentByBalance + recent + thisCall);
  const spentBefore = committed;
  const exceeded: AutoApproveOutcome["exceeded"] = [];
  let approvedNow = 0;
  for (const item of charge) {
    const amount = item.amount_coins;
    if (amount === null) {
      exceeded.push({ ...item, reason: "amount_unknown" });
      continue;
    }
    if (amount > ledger.cap) {
      exceeded.push({ ...item, reason: "single_card_over_cap" });
      continue;
    }
    if (committed + amount > ledger.cap) {
      exceeded.push({ ...item, reason: "cumulative_over_cap" });
      continue;
    }
    const result = await postConfirm(jobId, item.id, true, ctx, toolName);
    state.attempted.add(item.id);
    if (result.outcome === "approved") {
      committed = roundCoins(committed + amount);
      approvedNow += 1;
      state.approved.push({ id: item.id, amount_coins: amount, model: item.model, description: item.description });
    }
  }
  return {
    approvedNow,
    exceeded,
    remaining: nonCharge.length + exceeded.length,
    budget: {
      cap: ledger.cap,
      baseline_balance: ledger.baseline,
      balance_coins: quota.balance_coins,
      spent_estimate_before: spentBefore,
      spent_estimate: committed,
      estimate_source:
        "max(0, 开拍前余额−当前余额) ＋ 网关 recent_approved_coins ＋ 本次已批准；保守上界（可能重复计入），只会提早停",
    },
  };
}

// ── 快照判定（wait 循环与 get 共用）────────────────────────────────────────────

type Judgement =
  | { kind: "final"; summary: string; body: Record<string, unknown> }
  | { kind: "continue"; phase: string; reason?: string; budget?: Record<string, unknown> };

type GeneratedMedia = {
  task_id: string;
  kind: string;
  created_at: number | null;
  artifacts: Array<{ url: string; mime: string | null; width: number | null; height: number | null }>;
};

/**
 * 终态补抓：网关回执表里本会话成功落地的生成产物（公开 URL）。
 * 导演终稿常只引用 workspace 路径（出站净化成「（内部存档）」），只靠回覆文本抽 URL 会丢产物
 * （2026-11-02 复测 job 8606e683：回执 8 张成功图，artifacts.stills 只拿到 2 张）。
 * 旧网关无此端点／失败时只回说明，不影响原判定。
 */
async function fetchGeneratedMediaFields(jobId: string, ctx: McpToolContext, toolName: string): Promise<Record<string, unknown>> {
  const path = agentSessionPath(jobId, "/generations");
  try {
    const res = await ctx.dispatcher({ method: "GET", path, authorization: ctx.authorization, traceId: ctx.traceId, toolName });
    if (res.status < 200 || res.status >= 300) {
      return { generated_media: null, generated_media_note: `生成回执清单暂不可用（HTTP ${res.status}）；产物以 artifacts 为准。` };
    }
    const payload = parseJsonLoose(res.text);
    if (!isPlainObject(payload) || !Array.isArray(payload.generations)) {
      return { generated_media: null, generated_media_note: "生成回执清单格式不符；产物以 artifacts 为准。" };
    }
    const items: GeneratedMedia[] = [];
    for (const entry of payload.generations) {
      if (!isPlainObject(entry) || typeof entry.task_id !== "string" || !Array.isArray(entry.artifacts)) continue;
      const artifacts: GeneratedMedia["artifacts"] = [];
      for (const a of entry.artifacts) {
        if (!isPlainObject(a) || typeof a.url !== "string" || !/^https?:\/\//.test(a.url)) continue;
        artifacts.push({
          url: a.url,
          mime: typeof a.mime === "string" ? a.mime : null,
          width: finiteOrNull(a.width),
          height: finiteOrNull(a.height),
        });
      }
      if (artifacts.length === 0) continue;
      items.push({
        task_id: entry.task_id,
        kind: typeof entry.kind === "string" ? entry.kind : "unknown",
        created_at: finiteOrNull(entry.created_at),
        artifacts,
      });
    }
    return {
      generated_media: items,
      generated_media_note:
        "本会话全部成功生成的媒体（网关回执真源，含返工稿与历史轮次，按 created_at 升序）；导演挑定的交付以 artifacts 为准，artifacts 缺项时从这里取公开 URL。" +
        (payload.truncated === true ? "（清单已截断，只含最近 200 条）" : ""),
    };
  } catch {
    return { generated_media: null, generated_media_note: "生成回执清单读取失败；产物以 artifacts 为准。" };
  }
}

async function judgeSnapshot(opts: Parameters<typeof judgeSnapshotCore>[0]): Promise<Judgement> {
  const judged = await judgeSnapshotCore(opts);
  if (judged.kind !== "final") return judged;
  return { ...judged, body: { ...judged.body, ...(await fetchGeneratedMediaFields(opts.jobId, opts.ctx, opts.toolName)) } };
}

async function judgeSnapshotCore(opts: {
  jobId: string;
  runtime: JobRuntime;
  messages: AgentMessage[];
  fresh: AgentMessage[];
  ctx: McpToolContext;
  toolName: string;
  idleMeansDone: boolean;
  auto: AutoApproveState;
  nowMs: number;
  elapsedMs: number;
  extra?: Record<string, unknown>;
}): Promise<Judgement> {
  const { runtime } = opts;
  const artifacts = slimArtifacts(collectClassifiedArtifacts(opts.fresh.map((m) => m.text)));
  const summary = latestAssistantText(opts.fresh);
  const base = {
    job_id: opts.jobId,
    session_id: opts.jobId,
    status_source: runtime.source,
    artifacts,
    summary,
    elapsed_ms: opts.elapsedMs,
    do_not_resubmit: true,
    ...(opts.auto.approved.length > 0 ? { auto_approved: opts.auto.approved } : {}),
    ...(opts.extra ?? {}),
  };

  if (runtime.status === "waiting") {
    let budget: Record<string, unknown> | undefined;
    if (runtime.pending_questions === 0 && runtime.pending_confirms > 0) {
      const auto = await autoApproveWithinBudget(opts.jobId, runtime, opts.messages, opts.ctx, opts.toolName, opts.auto);
      budget = auto.budget;
      if (auto.exceeded.length > 0) {
        return {
          kind: "final",
          summary: "导演任务停在确认卡：超出预算上限，需用户决定（勿重提交；eimu_job approve/reject）。",
          body: {
            ...base,
            ...(opts.auto.approved.length > 0 ? { auto_approved: opts.auto.approved } : {}),
            status: "awaiting_input",
            ...questionFields(runtime),
            code: "budget_exceeded",
            phase: runtime.phase,
            pending_questions: runtime.pending_questions,
            pending_confirms: runtime.pending_confirms,
            confirm_cards: confirmCards(runtime),
            budget_exceeded: auto.exceeded,
            budget,
            message: "确认卡金额超出 budget_cap（单卡或累计）；未自动批准。请问用户后用 eimu_job approve（confirm_ids 可选）或 reject。",
            next_action: "ask_user_then_eimu_job_approve_or_reject",
            poll_after_seconds: EIMU_POLL_AFTER_SECONDS,
          },
        };
      }
      if (auto.approvedNow > 0 && auto.remaining === 0) {
        return { kind: "continue", phase: "auto_approved", reason: `auto_approved=${auto.approvedNow}`, budget };
      }
    }
    const cards = confirmCards(runtime);
    return {
      kind: "final",
      summary: "导演任务等待输入（勿重提交；确认卡用 eimu_job approve/reject，提问用 reply）。",
      body: {
        ...base,
        ...(opts.auto.approved.length > 0 ? { auto_approved: opts.auto.approved } : {}),
        status: "awaiting_input",
        ...questionFields(runtime),
        phase: runtime.phase,
        pending_questions: runtime.pending_questions,
        pending_confirms: runtime.pending_confirms,
        confirm_cards: cards,
        ...(budget ? { budget } : {}),
        ...(runtime.pending_confirms > 0 && cards === null
          ? { confirm_cards_note: "网关未投影确认卡明细（旧版）；无法按 id 批准，请到网页处理或升级网关。" }
          : {}),
        next_action: cards && cards.length > 0 ? "eimu_job_approve_or_reject" : "eimu_job_reply_or_approve",
        poll_after_seconds: EIMU_POLL_AFTER_SECONDS,
      },
    };
  }

  if (runtime.status === "running") return { kind: "continue", phase: runtime.phase };
  if (!opts.idleMeansDone) return { kind: "continue", phase: runtime.phase };

  const gate = idleGate(runtime, summary, artifacts, opts.nowMs);
  if (gate.kind === "busy") return { kind: "continue", phase: "background_running", reason: gate.reason };
  if (gate.kind === "stalled") {
    return {
      kind: "final",
      summary: "导演任务疑似停滞：会话 idle、回覆声称仍在生成但无产物且久无活动。",
      body: {
        ...base,
        status: "stalled",
        phase: "idle",
        reason: gate.reason,
        last_activity_at: runtime.last_activity_at,
        next_action: "eimu_job_reply_or_get",
        hint: "可用 eimu_job reply 追问进度，或 get_agent_session 看完整记录；勿重提交。",
      },
    };
  }
  return {
    kind: "final",
    summary: "导演任务已完成（会话 idle、无待确认、无后台子代理／生成）。",
    body: {
      ...base,
      status: "completed",
      phase: "idle",
      next_action: "read_artifacts_or_eimu_job_revise",
    },
  };
}

function processingBody(opts: {
  jobId: string;
  runtime: JobRuntime;
  fresh: AgentMessage[];
  phase: string;
  reason?: string;
  budget?: Record<string, unknown>;
  auto: AutoApproveState;
  elapsedMs: number;
  waitSeconds?: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const artifacts = slimArtifacts(collectClassifiedArtifacts(opts.fresh.map((m) => m.text)));
  return {
    job_id: opts.jobId,
    session_id: opts.jobId,
    status: "processing",
    phase: opts.phase,
    runtime_status: opts.runtime.status,
    status_source: opts.runtime.source,
    pending_questions: opts.runtime.pending_questions,
    pending_confirms: opts.runtime.pending_confirms,
    active_children: opts.runtime.active_children,
    inflight_generations: opts.runtime.inflight_generations,
    ...(opts.reason ? { processing_reason: opts.reason } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
    ...(opts.auto.approved.length > 0 ? { auto_approved: opts.auto.approved } : {}),
    artifacts,
    summary: latestAssistantText(opts.fresh),
    elapsed_ms: opts.elapsedMs,
    poll_after_seconds: EIMU_POLL_AFTER_SECONDS,
    do_not_resubmit: true,
    next_action: "eimu_job_wait_or_get",
    hint:
      opts.waitSeconds !== undefined
        ? `未在 ${opts.waitSeconds}s 内等到终态；任务可能仍在跑。勿重提交，用 eimu_job（job_id=${opts.jobId}）续查。`
        : `任务仍在跑；勿重提交，${EIMU_POLL_AFTER_SECONDS}s 后用 eimu_job（job_id=${opts.jobId}）续查。`,
    ...(opts.extra ?? {}),
  };
}

async function waitForTerminal(opts: {
  jobId: string;
  ctx: McpToolContext;
  toolName: string;
  waitSeconds: number;
  baselineCount: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  startedAt: number;
  /** true＝调用前已知会话在跑（wait／确认卡已处理），见到 idle 即可进入完成闸。 */
  assumeStarted?: boolean;
  extra?: Record<string, unknown>;
}): Promise<McpToolCallResult> {
  const deadlineAt = opts.startedAt + opts.waitSeconds * 1000;
  let seenNonIdle = opts.assumeStarted === true;
  const auto: AutoApproveState = { approved: [], attempted: new Set() };
  let runtime: JobRuntime | null = null;
  let fresh: AgentMessage[] = [];
  let lastPhase = "running";
  let lastReason: string | undefined;
  let lastBudget: Record<string, unknown> | undefined;

  for (;;) {
    runtime = await resolveJobRuntime(opts.jobId, opts.ctx, opts.toolName);
    if (runtime.status === "running" || runtime.status === "waiting") seenNonIdle = true;

    const detail = await fetchSessionDetail(opts.jobId, opts.ctx, opts.toolName);
    if (detail.error) return detail.error;
    const messages = detail.messages;
    const newSinceBaseline = opts.baselineCount < messages.length ? messages.slice(opts.baselineCount) : [];
    fresh = newSinceBaseline.length > 0 ? newSinceBaseline : messages;

    // 列表已 idle、但从未见到 running：基线后已有新 assistant 且至少过了一个轮询间隔，也进完成闸
    // （短任务可能在第一次 status 查询前就结束）。
    const shortTaskIdle =
      !seenNonIdle &&
      newSinceBaseline.some((m) => m.role === "assistant" && m.text.trim() !== "") &&
      opts.now() - opts.startedAt >= EIMU_DIRECTOR_POLL_INTERVAL_MS;

    const judged = await judgeSnapshot({
      jobId: opts.jobId,
      runtime,
      messages,
      fresh,
      ctx: opts.ctx,
      toolName: opts.toolName,
      idleMeansDone: seenNonIdle || shortTaskIdle,
      auto,
      nowMs: opts.now(),
      elapsedMs: opts.now() - opts.startedAt,
      extra: opts.extra,
    });
    if (judged.kind === "final") {
      const body =
        shortTaskIdle && !seenNonIdle && judged.body.status === "completed"
          ? { ...judged.body, note: "未观测到 running 中间态；以 idle + 新 assistant 判定完成（短任务竞态兜底）。" }
          : judged.body;
      return okResult(judged.summary, body);
    }
    lastPhase = judged.phase;
    lastReason = judged.reason;
    if (judged.budget) lastBudget = judged.budget;

    const remaining = deadlineAt - opts.now();
    if (remaining <= 0) break;
    await opts.sleep(Math.min(EIMU_DIRECTOR_POLL_INTERVAL_MS, remaining));
  }

  const body = processingBody({
    jobId: opts.jobId,
    runtime,
    fresh,
    phase: lastPhase,
    reason: lastReason,
    budget: lastBudget,
    auto,
    elapsedMs: opts.now() - opts.startedAt,
    waitSeconds: opts.waitSeconds,
    extra: opts.extra,
  });
  return okResult("导演任务处理中（有界等待超时；勿重提交）。", body);
}

/** 把「本次已写入的设置」挂到 structuredContent（不改原结果语义；无设置时原样返回）。 */
function withSettingsApplied(result: McpToolCallResult, applied: Record<string, unknown> | undefined): McpToolCallResult {
  if (!applied) return result;
  return { ...result, structuredContent: { ...(result.structuredContent ?? {}), settings_applied: applied } };
}

export async function eimuDirect(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolCallResult> {
  const prompt = pickString(args, "prompt") ?? "";
  if (!prompt) {
    return machineError({
      code: "invalid_params",
      message: "prompt 必填",
      retryable: false,
      next_action: "provide_prompt",
    });
  }

  const mode = normalizeMode(args.mode);
  const preflight = args.preflight === true || mode === "quote";
  const confirm = args.confirm === true;
  const budgetCap =
    typeof args.budget_cap === "number" && Number.isFinite(args.budget_cap) ? args.budget_cap : null;
  const waitSeconds = clampWaitSeconds(
    args.wait_seconds,
    EIMU_DIRECT_DEFAULT_WAIT_SECONDS,
    EIMU_DIRECT_MAX_WAIT_SECONDS,
  );
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? defaultSleep;
  const startedAt = now();

  // 极限＝thinking_level=extreme：先校验（失败即回 machineError，不读余额、不建会话）。
  const settingsPlan = buildAgentSettingsPatch(args, ["thinking_level", "beast_mode"]);
  if (!settingsPlan.ok) return settingsPlan.error;
  const hasSettingsPatch = Object.keys(settingsPlan.patch).length > 0;
  const plannedSettings = hasSettingsPatch
    ? { ...(settingsPlan.thinking_level ? { thinking_level: settingsPlan.thinking_level } : {}), patch: settingsPlan.patch }
    : undefined;

  const quota = await fetchQuotaCoins(ctx, "eimu_direct");
  if (quota.error && preflight) return quota.error;
  const priceTable = await fetchImagePriceTable(ctx, "eimu_direct");
  const quote = buildQuotePayload(mode, quota.balance_coins, quota.currency, priceTable);

  if (preflight) {
    // 报价没有建会话、没有任务可续查：正式跑就是再调一次 eimu_direct，这不算「重复提交」。
    const body = {
      status: "quoted",
      quote,
      do_not_resubmit: false,
      next_action: "eimu_direct_with_budget_cap_or_confirm",
      elapsed_ms: now() - startedAt,
      note: "preflight/quote 只报价：未建会话、未扣费、无 job_id。要正式跑，请再调用一次 eimu_direct（mode=full 或 plan，带 budget_cap 或 confirm=true）——这是首次提交，不算重复提交。",
      ...(plannedSettings ? { settings_planned: plannedSettings, settings_note: "报价不写设置；正式跑时先写入再开拍。" } : {}),
    };
    return okResult("报价完成（未提交）。", body);
  }

  if (budgetCap === null && !confirm) {
    const body = {
      status: "needs_confirmation",
      quote,
      code: "budget_required",
      message: "正式跑必须提供 budget_cap（数字）或 confirm=true；本次未提交、未扣费，补上参数后再调一次 eimu_direct 即可（不算重复提交）。",
      retryable: false,
      next_action: "eimu_direct_with_budget_cap_or_confirm",
      do_not_resubmit: false,
      elapsed_ms: now() - startedAt,
    };
    return structuredResult(JSON.stringify(body, null, 2), body, true);
  }

  if (quote.affordable === false && budgetCap !== null && quota.balance_coins !== null && budgetCap > quota.balance_coins) {
    // 仅提示；仍允许用户显式 confirm 硬闯（由业务层最终拒）。
  }
  if (quote.affordable === false && !confirm && budgetCap !== null && (quota.balance_coins ?? 0) < quote.estimated_coins) {
    const body = {
      status: "insufficient_quota",
      quote,
      code: "insufficient_quota",
      message: "余额低于粗估花费（见 quote.estimate_source）；本次未提交、未扣费。可降低 mode、充值，或显式 confirm=true 后再调一次 eimu_direct。",
      retryable: false,
      next_action: "top_up_or_confirm",
      do_not_resubmit: false,
      elapsed_ms: now() - startedAt,
    };
    return structuredResult(JSON.stringify(body, null, 2), body, true);
  }

  // 提交前先写账号级设置（与 save_agent_settings 同一 POST AGENT_SETTINGS_PATH）；写失败不开拍。
  let settingsApplied: Record<string, unknown> | undefined;
  if (plannedSettings) {
    const saved = await postAgentSettings(settingsPlan.patch, ctx, "eimu_direct");
    if (!saved.ok) return saved.error;
    settingsApplied = { ...plannedSettings, settings: saved.settings };
  }

  const ensured = await ensureSession(args, ctx, "eimu_direct");
  if ("error" in ensured) return withSettingsApplied(ensured.error, settingsApplied);
  const jobId = ensured.sessionId;

  const before = await fetchSessionDetail(jobId, ctx, "eimu_direct");
  if (before.error) return withSettingsApplied(before.error, settingsApplied);
  const baselineCount = before.message_count;

  const built = buildDirectorPrompt(args, mode, budgetCap, quota.balance_coins);
  const sent = await ctx.dispatcher({
    method: "POST",
    path: agentSessionPath(jobId, "/messages"),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "eimu_direct",
    body: compact({ content: built.content, session_directive: built.session_directive }),
  });
  if (sent.status < 200 || sent.status >= 300) {
    return withSettingsApplied(upstreamFailure("POST", agentSessionPath(jobId, "/messages"), sent), settingsApplied);
  }

  const result = await waitForTerminal({
    jobId,
    ctx,
    toolName: "eimu_direct",
    waitSeconds,
    baselineCount,
    now,
    sleep,
    startedAt,
  });
  return withSettingsApplied(result, settingsApplied);
}

function readConfirmIds(args: Record<string, unknown>): string[] | null {
  if (!Array.isArray(args.confirm_ids)) return null;
  const ids = args.confirm_ids.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim());
  return ids.length > 0 ? [...new Set(ids)] : null;
}

interface QuestionAnswerResult {
  id: string;
  outcome: "answered" | "expired" | "error";
  http_status: number;
}

/**
 * 依 questions 顺序组 answers（string[][]，网关 isQuestionAnswers 要求每格非空）：
 * args.answers 可为 string[]（每题一个）或 string[][]；缺省／空格用 message 作自由回答。
 */
function buildQuestionAnswers(item: PendingQuestionItem, raw: unknown, message: string): string[][] {
  const given = Array.isArray(raw) ? raw : [];
  const count = Math.max(1, item.questions.length);
  const out: string[][] = [];
  for (let i = 0; i < count; i += 1) {
    const cell = given[i];
    const row = (Array.isArray(cell) ? cell : [cell]).filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    out.push(row.length > 0 ? row : [message]);
  }
  return out;
}

/** POST /sessions/:id/question {request_id, answers}（照抄 src/lib/agent-chat-client/session.ts replyAgentQuestion）。 */
async function postQuestionAnswer(
  jobId: string,
  item: PendingQuestionItem,
  answers: string[][],
  ctx: McpToolContext,
): Promise<QuestionAnswerResult> {
  const response = await ctx.dispatcher({
    method: "POST",
    path: agentSessionPath(jobId, "/question"),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "eimu_job",
    body: { request_id: item.request_id, answers },
  });
  if (response.status >= 200 && response.status < 300) {
    return { id: item.request_id, outcome: "answered", http_status: response.status };
  }
  // 网关 handleQuestion：未知／已结算 request_id 回 404 question_expired。
  if (response.status === 404) return { id: item.request_id, outcome: "expired", http_status: 404 };
  return { id: item.request_id, outcome: "error", http_status: response.status };
}

async function sendJobMessage(jobId: string, message: string, ctx: McpToolContext): Promise<McpToolCallResult | null> {
  const sent = await ctx.dispatcher({
    method: "POST",
    path: agentSessionPath(jobId, "/messages"),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "eimu_job",
    body: { content: message },
  });
  if (sent.status < 200 || sent.status >= 300) return upstreamFailure("POST", agentSessionPath(jobId, "/messages"), sent);
  return null;
}

export async function eimuJob(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolCallResult> {
  const jobId = pickString(args, "job_id") ?? "";
  if (!jobId) {
    return machineError({
      code: "invalid_params",
      message: "job_id 必填",
      retryable: false,
      next_action: "provide_job_id",
    });
  }
  const action = normalizeAction(args.action);
  const now = ctx.now ?? (() => Date.now());
  const sleep = ctx.sleep ?? defaultSleep;
  const startedAt = now();
  const waitSeconds = clampWaitSeconds(args.timeout_seconds, EIMU_JOB_DEFAULT_WAIT_SECONDS, EIMU_JOB_MAX_WAIT_SECONDS);

  if (action === "cancel") {
    const aborted = await ctx.dispatcher({
      method: "POST",
      path: agentSessionPath(jobId, "/abort"),
      authorization: ctx.authorization,
      traceId: ctx.traceId,
      toolName: "eimu_job",
      body: {},
    });
    if (aborted.status < 200 || aborted.status >= 300) {
      return upstreamFailure("POST", agentSessionPath(jobId, "/abort"), aborted);
    }
    const body = {
      job_id: jobId,
      session_id: jobId,
      status: "cancelled",
      do_not_resubmit: true,
      next_action: "none",
      elapsed_ms: now() - startedAt,
    };
    return okResult("已请求中止导演任务。", body);
  }

  // approve／reject：先处理结构化确认卡（与前端同一 POST /confirm）；没有卡才回落发文字讯息。
  if (action === "approve" || action === "reject") {
    const approved = action === "approve";
    const requestedIds = readConfirmIds(args);
    const runtime = await resolveJobRuntime(jobId, ctx, "eimu_job");
    const items = runtime.pending_confirm_items;
    if (!requestedIds && items === null && runtime.pending_confirms > 0) {
      return machineError({
        code: "confirm_ids_unavailable",
        message: `会话有 ${runtime.pending_confirms} 张待确认卡，但网关未投影卡明细（旧版网关），无法确定 request_id；请带 confirm_ids，或到网页处理。`,
        retryable: false,
        next_action: "provide_confirm_ids_or_use_web_ui",
        job_id: jobId,
      });
    }
    const targets = requestedIds ?? (items ?? []).map((item) => item.id);
    const message = pickString(args, "message");
    if (targets.length > 0) {
      const results: ConfirmResult[] = [];
      for (const id of targets) results.push(await postConfirm(jobId, id, approved, ctx, "eimu_job"));
      if (results.every((r) => r.outcome === "error")) {
        return machineError({
          code: "confirm_failed",
          message: `确认卡${approved ? "批准" : "拒绝"}全部失败（上游非 2xx）。`,
          retryable: true,
          next_action: "retry_later",
          job_id: jobId,
          confirm_results: results,
        });
      }
      // 附带 message：作为补充指示送进会话（例如「拒绝后改用便宜模型」）。
      if (message) {
        const failed = await sendJobMessage(jobId, message, ctx);
        if (failed) return failed;
      }
      return waitForTerminal({
        jobId,
        ctx,
        toolName: "eimu_job",
        waitSeconds,
        baselineCount: 0,
        now,
        sleep,
        startedAt,
        assumeStarted: true,
        extra: { confirm_results: results },
      });
    }
    if (!approved && !message) {
      return machineError({
        code: "no_pending_confirms",
        message: "当前没有待确认卡；reject 需要 confirm_ids 或 message（文字形式的拒绝／改向）。",
        retryable: false,
        next_action: "eimu_job_get_or_reply",
        job_id: jobId,
      });
    }
  }

  if (action === "reply" || action === "approve" || action === "reject" || action === "revise") {
    const message =
      pickString(args, "message") ??
      (action === "approve" ? "批准，请在预算内继续。" : "");
    if (!message) {
      return machineError({
        code: "invalid_params",
        message: `${action} 需要 message`,
        retryable: false,
        next_action: "provide_message",
        job_id: jobId,
      });
    }
    const before = await fetchSessionDetail(jobId, ctx, "eimu_job");
    if (before.error) return before.error;
    // H11：导演挂着 question 卡时，reply 必须走 POST /question 作答（与前端 replyAgentQuestion 同端点同 body）；
    // 只发新讯息不会解开 question，卡会在 QUESTION_ASSUME_MS 后被按超时拒绝。
    const pendingRuntime = await resolveJobRuntime(jobId, ctx, "eimu_job");
    const questionItems = pendingRuntime.pending_question_items ?? [];
    if (questionItems.length > 0) {
      const results = [];
      for (const item of questionItems) {
        results.push(await postQuestionAnswer(jobId, item, buildQuestionAnswers(item, args.answers, message), ctx));
      }
      if (results.some((r) => r.outcome === "answered")) {
        return waitForTerminal({
          jobId,
          ctx,
          toolName: "eimu_job",
          waitSeconds,
          baselineCount: 0,
          now,
          sleep,
          startedAt,
          assumeStarted: true,
          extra: { question_results: results },
        });
      }
      if (results.every((r) => r.outcome === "error")) {
        return machineError({
          code: "question_answer_failed",
          message: "question 卡作答全部失败（上游非 2xx）。",
          retryable: true,
          next_action: "retry_later",
          job_id: jobId,
          question_results: results,
        });
      }
      // 全部 expired：卡已超时被拒，退回发文字讯息让导演据此继续。
    }
    const failed = await sendJobMessage(jobId, message, ctx);
    if (failed) return failed;
    return waitForTerminal({
      jobId,
      ctx,
      toolName: "eimu_job",
      waitSeconds,
      baselineCount: before.message_count,
      now,
      sleep,
      startedAt,
    });
  }

  if (action === "wait") {
    // wait：调用前会话已提交过，见到 idle 即进完成闸（仍需无后台子代理／生成、无待确认）。
    return waitForTerminal({
      jobId,
      ctx,
      toolName: "eimu_job",
      waitSeconds,
      baselineCount: 0,
      now,
      sleep,
      startedAt,
      assumeStarted: true,
    });
  }

  // action === get：单次快照，同一完成闸；budget_cap 内的扣费卡在此自动批准。
  const runtime = await resolveJobRuntime(jobId, ctx, "eimu_job");
  const detail = await fetchSessionDetail(jobId, ctx, "eimu_job");
  if (detail.error) return detail.error;
  const auto: AutoApproveState = { approved: [], attempted: new Set() };
  const judged = await judgeSnapshot({
    jobId,
    runtime,
    messages: detail.messages,
    fresh: detail.messages,
    ctx,
    toolName: "eimu_job",
    idleMeansDone: true,
    auto,
    nowMs: now(),
    elapsedMs: now() - startedAt,
    extra: { message_count: detail.message_count, runtime_status: runtime.status },
  });
  if (judged.kind === "final") {
    const status = String(judged.body.status);
    return okResult(`导演任务快照：${status}。`, judged.body);
  }
  const body = processingBody({
    jobId,
    runtime,
    fresh: detail.messages,
    phase: judged.phase,
    reason: judged.reason,
    budget: judged.budget,
    auto,
    elapsedMs: now() - startedAt,
    extra: { message_count: detail.message_count, next_action: "eimu_job_wait" },
  });
  return okResult("导演任务快照：processing。", body);
}

const DIRECTOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    job_id: { type: "string" },
    session_id: { type: "string" },
    status: {
      type: "string",
      enum: [
        "quoted",
        "needs_confirmation",
        "processing",
        "awaiting_input",
        "completed",
        "stalled",
        "cancelled",
        "insufficient_quota",
      ],
    },
    code: { type: "string", description: "awaiting_input 时可为 budget_exceeded（超 budget_cap，需用户决定）。" },
    confirm_cards: {
      type: ["array", "null"],
      description: "待确认卡（id 即网关 request_id，可喂 eimu_job confirm_ids）；null＝网关未投影明细。",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          charge: { type: "boolean" },
          amount_coins: { type: ["number", "null"] },
          model: { type: ["string", "null"] },
          task_id: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
        },
      },
    },
    auto_approved: { type: "array", description: "本次轮询在 budget_cap 内自动批准的扣费卡。", items: { type: "object" } },
    budget_exceeded: { type: "array", description: "超出 budget_cap 未自动批准的卡（带 reason）。", items: { type: "object" } },
    budget: { type: "object", description: "预算记账（cap／基线／当前余额／累计估算与来源）。" },
    confirm_results: { type: "array", items: { type: "object" } },
    artifacts: { type: "object" },
    generated_media: {
      type: ["array", "null"],
      description: "终态时附：本会话全部成功生成的媒体（网关回执真源，含返工稿；每项 task_id/kind/created_at/artifacts[url,mime,width,height]）。null＝清单不可用。",
      items: { type: "object" },
    },
    generated_media_note: { type: "string" },
    poll_after_seconds: { type: "number" },
    do_not_resubmit: { type: "boolean" },
    next_action: { type: "string" },
    quote: { type: "object" },
  },
};

/** 导演工具定义（真实现）。 */
export function defineDirectorTools(): ToolDefinition[] {
  return [
    {
      name: "eimu_direct",
      title: "导演派工",
      description: bilingual(
        "把一句话交给 Eimu 导演。有界等待≤45s；超时回 processing＋job_id，勿重提交，用 eimu_job 续查。quote/preflight 只报价（不建任务，之后再调本工具正式跑不算重提交）；正式跑须 budget_cap 或 confirm=true。带 budget_cap 时轮询中会在上限内（单卡与累计）自动批准扣费确认卡，超出回 code=budget_exceeded。终态产物含成片与分镜／brief／首尾帧／成品静帧 stills（电商主图／卖点／细节等，带原标签）／配音。极限模式＝thinking_level=extreme（开拍前先写账号设置，野兽模式开）。",
        "Hand a one-line brief to the Eimu director. Bounded wait <=45s; on timeout returns processing + job_id + poll_after_seconds - do NOT resubmit, poll with eimu_job. preflight/mode=quote only quotes (no charge, no job; calling eimu_direct again for the real run is not a resubmit); a real run requires budget_cap (coins) or confirm=true. With budget_cap, charge confirm cards within the cap (per card and cumulative) are auto-approved while polling; over the cap returns code=budget_exceeded. Terminal results include film, storyboard, brief, bible, keyframes (first/last frames), stills (finished stills such as e-commerce main/detail images, with their labels) and audio. Extreme mode = thinking_level=extreme (saved to account settings before the run; turns beast mode on).",
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      outputSchema: DIRECTOR_OUTPUT_SCHEMA,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "一句话需求／剧本摘要／改片意见，必填，最长 8000 字。" },
          mode: {
            type: "string",
            enum: ["quote", "plan", "full"],
            description: "quote=只报价；plan=方案；full=开拍。默认 full。",
          },
          preflight: {
            type: "boolean",
            description: "true=只报价不提交（与 mode=quote 同类）；不扣费。",
          },
          budget_cap: {
            type: "number",
            minimum: 0,
            description: "预算上限（币，与 get_quota.balance_coins 同单位）。正式跑须本栏或 confirm=true。",
          },
          confirm: {
            type: "boolean",
            description: "true=跳过预算确认闸（仍会读余额提示）；与 budget_cap 二选一即可提交。",
          },
          wait_seconds: {
            type: "integer",
            minimum: 1,
            maximum: EIMU_DIRECT_MAX_WAIT_SECONDS,
            description: `有界等待秒数，默认 ${EIMU_DIRECT_DEFAULT_WAIT_SECONDS}，上限 ${EIMU_DIRECT_MAX_WAIT_SECONDS}。`,
          },
          session_id: { type: "string", description: "续用既有导演／agent 会话；省略则新建。返回的 job_id 即 session_id。" },
          aspect_ratio: { type: "string", description: "画幅，如 16:9 / 9:16 / 1:1。" },
          duration_seconds: {
            type: "integer",
            minimum: 1,
            maximum: 600,
            description: "目标成片时长（秒）。",
          },
          reference_urls: {
            type: "array",
            items: { type: "string" },
            maxItems: 8,
            description: "参考图／视频／音频的公网 URL 列表。",
          },
          style: { type: "string", description: "风格关键词（可选）。" },
          thinking_level: THINKING_LEVEL_SCHEMA,
          beast_mode: BEAST_MODE_SCHEMA,
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      run: (args, ctx) => eimuDirect(args, ctx),
    },
    {
      name: "eimu_job",
      title: "导演任务",
      description: bilingual(
        "对导演 job_id 执行 get|wait|reply|approve|reject|revise|cancel。wait≤45s，超时仍 processing，勿重提交。completed 须会话 idle、无待确认、无后台子代理／生成；awaiting_input 时 confirm_cards 列出确认卡（id／金额／模型／说明），approve／reject 按 confirm_ids（默认全部）走确认端点；questions 列出导演 question 卡（题面／选项），reply 用 answers 或 message 作答（约 3 分钟内，否则超时拒绝）。终态另附 generated_media（本会话全部成功生成的公开 URL，含返工稿），artifacts 缺项时从中取。",
        "Act on a director job_id: get|wait|reply|approve|reject|revise|cancel. Bounded wait <=45s; still processing on timeout - do NOT resubmit. completed requires an idle session with no pending questions/confirms and no running sub-agents or generations. awaiting_input lists confirm_cards (id/amount/model/description); approve/reject resolve them by confirm_ids (default: all) via the confirm endpoint; questions lists the director's question cards (text/options) - answer with reply using answers (option labels in question order) or message, within ~3 minutes or the gateway rejects them as timed out. Terminal results also carry generated_media (every successful generation in the session with public URLs, including reworks); use it when artifacts misses an item.",
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      outputSchema: DIRECTOR_OUTPUT_SCHEMA,
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "来自 eimu_direct 的 job_id（当前即 session_id）。" },
          action: {
            type: "string",
            enum: ["get", "wait", "reply", "approve", "reject", "revise", "cancel"],
            description: "默认 get。approve／reject 处理确认卡；无卡时 approve 发默认批准文字、reject 需 message。",
          },
          confirm_ids: {
            type: "array",
            items: { type: "string" },
            maxItems: 50,
            description: "approve／reject 要处理的确认卡 id（来自 confirm_cards[].id）；省略＝当前全部待确认卡。",
          },
          answers: {
            type: "array",
            maxItems: 10,
            items: { type: "string" },
            description: "reply 回答 question 卡：依 questions[] 顺序，每题一个选项 label；缺项用 message 作自由回答。",
          },
          message: {
            type: "string",
            description: "reply／revise 时的用户回复或改片意见；approve 可省略（有默认批准文案）；approve／reject 处理卡后若带 message 会作为补充指示送进会话。",
          },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: EIMU_JOB_MAX_WAIT_SECONDS,
            description: `wait／reply／revise／approve 后的有界等待秒数，默认 ${EIMU_JOB_DEFAULT_WAIT_SECONDS}，上限 ${EIMU_JOB_MAX_WAIT_SECONDS}。`,
          },
        },
        required: ["job_id"],
        additionalProperties: false,
      },
      run: (args, ctx) => eimuJob(args, ctx),
    },
  ];
}
