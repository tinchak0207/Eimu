/**
 * 导演入口：eimu_direct / eimu_job。
 *
 * - 有界等待默认 ≤45s；超时回 processing + job_id + poll_after_seconds，明说勿重提交。
 * - 完成判定走网关会话运行态（status idle|running|waiting），不是「第一条 assistant 文本」。
 * - 花费闸：preflight / mode=quote 只报价；正式跑须 budget_cap 或 confirm=true。
 * - 产物 structuredContent 分类 film/storyboard/brief/bible/keyframes/audio。
 * job_id 当前等价于 agent session_id（与 biz 闸道同一身分空间）。
 */

import { machineError, structuredResult, type McpToolCallResult } from "../protocol";
import {
  agentSessionPath,
  collectClassifiedArtifacts,
  type DirectorArtifactCategory,
} from "./agent";
import {
  AGENT_SESSIONS_PATH,
  EIMU_DIRECT_DEFAULT_WAIT_SECONDS,
  EIMU_DIRECT_MAX_WAIT_SECONDS,
  EIMU_DIRECTOR_POLL_INTERVAL_MS,
  EIMU_JOB_DEFAULT_WAIT_SECONDS,
  EIMU_JOB_MAX_WAIT_SECONDS,
  EIMU_POLL_AFTER_SECONDS,
  EIMU_QUOTE_ESTIMATE_COINS,
  QUOTA_PATH,
} from "./constants";
import { compact, pickString } from "./helpers";
import type { McpDispatchResponse, McpToolContext, ToolDefinition } from "./types";
import { isPlainObject } from "./validation";

type SessionRuntimeStatus = "idle" | "running" | "waiting";
type DirectorMode = "quote" | "plan" | "full";
type JobAction = "get" | "wait" | "reply" | "approve" | "revise" | "cancel";

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
  if (raw === "get" || raw === "wait" || raw === "reply" || raw === "approve" || raw === "revise" || raw === "cancel") {
    return raw;
  }
  return "get";
}

function upstreamFailure(method: string, path: string, response: McpDispatchResponse): McpToolCallResult {
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

function estimateCoins(mode: DirectorMode): number {
  return EIMU_QUOTE_ESTIMATE_COINS[mode];
}

function buildQuotePayload(mode: DirectorMode, balanceCoins: number | null, currency: string | null) {
  const estimated = estimateCoins(mode);
  const affordable = balanceCoins === null ? null : balanceCoins >= estimated;
  return {
    mode,
    estimated_coins: estimated,
    balance_coins: balanceCoins,
    currency: currency ?? "coins",
    affordable,
    note: "粗估，非计费真源；正式扣费以帐本为准。quote/preflight 不扣费。",
  };
}

function emptyArtifacts(): Record<DirectorArtifactCategory, Array<{ url: string; mime: string; label: string }>> {
  return { film: [], storyboard: [], brief: [], bible: [], keyframes: [], audio: [] };
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
async function resolveJobRuntime(
  jobId: string,
  ctx: McpToolContext,
  toolName: string,
): Promise<{
  status: SessionRuntimeStatus;
  phase: string;
  pending_questions: number;
  pending_confirms: number;
  source: "status_endpoint" | "session_list" | "assumed_running";
  detail?: unknown;
}> {
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

function buildDirectorPrompt(args: Record<string, unknown>, mode: DirectorMode, budgetCap: number | null): {
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

async function waitForTerminal(opts: {
  jobId: string;
  ctx: McpToolContext;
  toolName: string;
  waitSeconds: number;
  baselineCount: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  startedAt: number;
}): Promise<McpToolCallResult> {
  const deadlineAt = opts.startedAt + opts.waitSeconds * 1000;
  let seenNonIdle = false;
  let lastStatus: SessionRuntimeStatus = "running";
  let lastPhase = "running";
  let pendingQuestions = 0;
  let pendingConfirms = 0;
  let statusSource: string = "assumed_running";
  let messages: AgentMessage[] = [];

  for (;;) {
    const runtime = await resolveJobRuntime(opts.jobId, opts.ctx, opts.toolName);
    lastStatus = runtime.status;
    lastPhase = runtime.phase;
    pendingQuestions = runtime.pending_questions;
    pendingConfirms = runtime.pending_confirms;
    statusSource = runtime.source;
    if (runtime.status === "running" || runtime.status === "waiting") seenNonIdle = true;

    const detail = await fetchSessionDetail(opts.jobId, opts.ctx, opts.toolName);
    if (detail.error) return detail.error;
    messages = detail.messages;

    if (runtime.status === "waiting") {
      const fresh = opts.baselineCount < messages.length ? messages.slice(opts.baselineCount) : messages;
      const artifacts = slimArtifacts(collectClassifiedArtifacts(fresh.map((m) => m.text)));
      const summary = latestAssistantText(fresh);
      const body = {
        job_id: opts.jobId,
        session_id: opts.jobId,
        status: "awaiting_input",
        phase: lastPhase,
        pending_questions: pendingQuestions,
        pending_confirms: pendingConfirms,
        status_source: statusSource,
        artifacts,
        summary,
        elapsed_ms: opts.now() - opts.startedAt,
        do_not_resubmit: true,
        next_action: "eimu_job_reply_or_approve",
        poll_after_seconds: EIMU_POLL_AFTER_SECONDS,
      };
      return okResult("导演任务等待输入（勿重提交；用 eimu_job reply/approve）。", body);
    }

    if (runtime.status === "idle" && seenNonIdle) {
      const fresh = opts.baselineCount < messages.length ? messages.slice(opts.baselineCount) : messages;
      const artifacts = slimArtifacts(collectClassifiedArtifacts(fresh.map((m) => m.text)));
      const summary = latestAssistantText(fresh);
      const body = {
        job_id: opts.jobId,
        session_id: opts.jobId,
        status: "completed",
        phase: "idle",
        status_source: statusSource,
        artifacts,
        summary,
        elapsed_ms: opts.now() - opts.startedAt,
        do_not_resubmit: true,
        next_action: "read_artifacts_or_eimu_job_revise",
      };
      return okResult("导演任务已到会话终态 idle。", body);
    }

    // 列表已 idle、但从未见到 running：若基线后已有新 assistant 且至少轮询过一轮，也视为完成
    // （短任务可能在第一次 status 查询前就结束）。
    if (runtime.status === "idle" && !seenNonIdle) {
      const fresh = opts.baselineCount < messages.length ? messages.slice(opts.baselineCount) : [];
      const assistants = fresh.filter((m) => m.role === "assistant" && m.text.trim() !== "");
      if (assistants.length > 0 && opts.now() - opts.startedAt >= EIMU_DIRECTOR_POLL_INTERVAL_MS) {
        const artifacts = slimArtifacts(collectClassifiedArtifacts(fresh.map((m) => m.text)));
        const body = {
          job_id: opts.jobId,
          session_id: opts.jobId,
          status: "completed",
          phase: "idle",
          status_source: statusSource,
          artifacts,
          summary: latestAssistantText(fresh),
          elapsed_ms: opts.now() - opts.startedAt,
          do_not_resubmit: true,
          next_action: "read_artifacts_or_eimu_job_revise",
          note: "未观测到 running 中间态；以 idle + 新 assistant 判定完成（短任务竞态兜底）。",
        };
        return okResult("导演任务已完成（短任务竞态兜底）。", body);
      }
    }

    const remaining = deadlineAt - opts.now();
    if (remaining <= 0) break;
    await opts.sleep(Math.min(EIMU_DIRECTOR_POLL_INTERVAL_MS, remaining));
  }

  const fresh = opts.baselineCount < messages.length ? messages.slice(opts.baselineCount) : messages;
  const artifacts = slimArtifacts(collectClassifiedArtifacts(fresh.map((m) => m.text)));
  const body = {
    job_id: opts.jobId,
    session_id: opts.jobId,
    status: "processing",
    phase: lastPhase,
    runtime_status: lastStatus,
    status_source: statusSource,
    pending_questions: pendingQuestions,
    pending_confirms: pendingConfirms,
    artifacts,
    summary: latestAssistantText(fresh),
    elapsed_ms: opts.now() - opts.startedAt,
    poll_after_seconds: EIMU_POLL_AFTER_SECONDS,
    do_not_resubmit: true,
    next_action: "eimu_job_wait_or_get",
    hint: `未在 ${opts.waitSeconds}s 内等到终态；任务可能仍在跑。勿重提交，用 eimu_job（job_id=${opts.jobId}）续查。`,
  };
  return okResult("导演任务处理中（有界等待超时；勿重提交）。", body);
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

  const quota = await fetchQuotaCoins(ctx, "eimu_direct");
  if (quota.error && preflight) return quota.error;
  const quote = buildQuotePayload(mode === "quote" ? "quote" : mode, quota.balance_coins, quota.currency);

  if (preflight) {
    const body = {
      status: "quoted",
      quote,
      do_not_resubmit: true,
      next_action: "confirm_or_set_budget",
      elapsed_ms: now() - startedAt,
      note: "preflight/quote 只报价，未建会话、未扣费。正式跑请带 budget_cap 或 confirm=true。",
    };
    return okResult("报价完成（未提交）。", body);
  }

  if (budgetCap === null && !confirm) {
    const body = {
      status: "needs_confirmation",
      quote,
      code: "budget_required",
      message: "正式跑必须提供 budget_cap（数字）或 confirm=true；本次未提交、未扣费。",
      retryable: false,
      next_action: "confirm_or_set_budget",
      do_not_resubmit: true,
      elapsed_ms: now() - startedAt,
    };
    return structuredResult(JSON.stringify(body, null, 2), body, true);
  }

  if (quote.affordable === false && budgetCap !== null && quota.balance_coins !== null && budgetCap > quota.balance_coins) {
    // 仅提示；仍允许用户显式 confirm 硬闯（由业务层最终拒）。
  }
  if (quote.affordable === false && !confirm && budgetCap !== null && (quota.balance_coins ?? 0) < estimateCoins(mode)) {
    const body = {
      status: "insufficient_quota",
      quote,
      code: "insufficient_quota",
      message: "余额低于粗估花费；可降低 mode、充值，或显式 confirm=true 后重试。",
      retryable: false,
      next_action: "top_up_or_confirm",
      do_not_resubmit: true,
      elapsed_ms: now() - startedAt,
    };
    return structuredResult(JSON.stringify(body, null, 2), body, true);
  }

  const ensured = await ensureSession(args, ctx, "eimu_direct");
  if ("error" in ensured) return ensured.error;
  const jobId = ensured.sessionId;

  const before = await fetchSessionDetail(jobId, ctx, "eimu_direct");
  if (before.error) return before.error;
  const baselineCount = before.message_count;

  const built = buildDirectorPrompt(args, mode, budgetCap);
  const sent = await ctx.dispatcher({
    method: "POST",
    path: agentSessionPath(jobId, "/messages"),
    authorization: ctx.authorization,
    traceId: ctx.traceId,
    toolName: "eimu_direct",
    body: compact({ content: built.content, session_directive: built.session_directive }),
  });
  if (sent.status < 200 || sent.status >= 300) {
    return upstreamFailure("POST", agentSessionPath(jobId, "/messages"), sent);
  }

  return waitForTerminal({
    jobId,
    ctx,
    toolName: "eimu_direct",
    waitSeconds,
    baselineCount,
    now,
    sleep,
    startedAt,
  });
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

  if (action === "reply" || action === "approve" || action === "revise") {
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
    const sent = await ctx.dispatcher({
      method: "POST",
      path: agentSessionPath(jobId, "/messages"),
      authorization: ctx.authorization,
      traceId: ctx.traceId,
      toolName: "eimu_job",
      body: { content: message },
    });
    if (sent.status < 200 || sent.status >= 300) {
      return upstreamFailure("POST", agentSessionPath(jobId, "/messages"), sent);
    }
    const waitSeconds = clampWaitSeconds(
      args.timeout_seconds,
      EIMU_JOB_DEFAULT_WAIT_SECONDS,
      EIMU_JOB_MAX_WAIT_SECONDS,
    );
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
    const waitSeconds = clampWaitSeconds(
      args.timeout_seconds,
      EIMU_JOB_DEFAULT_WAIT_SECONDS,
      EIMU_JOB_MAX_WAIT_SECONDS,
    );
    const before = await fetchSessionDetail(jobId, ctx, "eimu_job");
    if (before.error) return before.error;
    // wait：从当前 message_count 起算；若已 idle 则直接快照。
    const runtime = await resolveJobRuntime(jobId, ctx, "eimu_job");
    if (runtime.status === "idle") {
      const artifacts = slimArtifacts(collectClassifiedArtifacts(before.messages.map((m) => m.text)));
      const body = {
        job_id: jobId,
        session_id: jobId,
        status: "completed",
        phase: "idle",
        status_source: runtime.source,
        artifacts,
        summary: latestAssistantText(before.messages),
        elapsed_ms: now() - startedAt,
        do_not_resubmit: true,
        next_action: "read_artifacts_or_eimu_job_revise",
      };
      return okResult("导演任务已在终态 idle。", body);
    }
    if (runtime.status === "waiting") {
      const artifacts = slimArtifacts(collectClassifiedArtifacts(before.messages.map((m) => m.text)));
      const body = {
        job_id: jobId,
        session_id: jobId,
        status: "awaiting_input",
        phase: runtime.phase,
        pending_questions: runtime.pending_questions,
        pending_confirms: runtime.pending_confirms,
        status_source: runtime.source,
        artifacts,
        summary: latestAssistantText(before.messages),
        elapsed_ms: now() - startedAt,
        do_not_resubmit: true,
        next_action: "eimu_job_reply_or_approve",
        poll_after_seconds: EIMU_POLL_AFTER_SECONDS,
      };
      return okResult("导演任务等待输入。", body);
    }
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

  // action === get
  const runtime = await resolveJobRuntime(jobId, ctx, "eimu_job");
  const detail = await fetchSessionDetail(jobId, ctx, "eimu_job");
  if (detail.error) return detail.error;
  const artifacts = slimArtifacts(collectClassifiedArtifacts(detail.messages.map((m) => m.text)));
  const status =
    runtime.status === "waiting" ? "awaiting_input" : runtime.status === "running" ? "processing" : "completed";
  const body = {
    job_id: jobId,
    session_id: jobId,
    status,
    phase: runtime.phase,
    runtime_status: runtime.status,
    status_source: runtime.source,
    pending_questions: runtime.pending_questions,
    pending_confirms: runtime.pending_confirms,
    message_count: detail.message_count,
    artifacts,
    summary: latestAssistantText(detail.messages),
    elapsed_ms: now() - startedAt,
    do_not_resubmit: true,
    next_action:
      status === "processing"
        ? "eimu_job_wait"
        : status === "awaiting_input"
          ? "eimu_job_reply_or_approve"
          : "read_artifacts_or_eimu_job_revise",
    ...(status === "processing" ? { poll_after_seconds: EIMU_POLL_AFTER_SECONDS } : {}),
  };
  return okResult(`导演任务快照：${status}。`, body);
}

const DIRECTOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    job_id: { type: "string" },
    session_id: { type: "string" },
    status: {
      type: "string",
      enum: ["quoted", "needs_confirmation", "processing", "awaiting_input", "completed", "cancelled", "insufficient_quota"],
    },
    artifacts: { type: "object" },
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
      description:
        "把一句话交给 Eimu 导演。有界等待≤45s；超时回 processing＋job_id，勿重提交，用 eimu_job 续查。quote/preflight 只报价；正式跑须 budget_cap 或 confirm=true。终态产物含成片与分镜／brief／首尾帧／配音。",
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
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      run: (args, ctx) => eimuDirect(args, ctx),
    },
    {
      name: "eimu_job",
      title: "导演任务",
      description:
        "对导演 job_id 执行 get|wait|reply|approve|revise|cancel。wait≤45s，超时仍 processing，勿重提交。终态看会话 idle/waiting，交付成片与中间产物。",
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
            enum: ["get", "wait", "reply", "approve", "revise", "cancel"],
            description: "默认 get。",
          },
          message: { type: "string", description: "reply／revise 时的用户回复或改片意见；approve 可省略（有默认批准文案）。" },
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
