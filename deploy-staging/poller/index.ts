import { serve } from "bun";
import { pollPathFor } from "./media-endpoints";

// ============================================================
// Configuration
// ============================================================
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8081";
// WP3：VPS 本机直连控面（不经 Vercel 边缘/Cloudflare）。实测 store.tinchak0207.xyz/
// image-control/api/v1 的 /openapi.json body sha256 与公网域名 image.tinchak0207.xyz/v1
// 完全相同（同一后端），延时约 14ms vs 88~113ms。语义不变，只是换快路径。
const PLATFORM_API_BASE = process.env.PLATFORM_API_BASE ?? "https://store.tinchak0207.xyz/image-control/api/v1";
const POLLER_TICK_MS = parseInt(process.env.POLLER_TICK_MS ?? "1000", 10);
// WP1 前段密集快探：任务创建后 FAST_PROBE_WINDOW_MS 内以 FAST_PROBE_TICK_MS 间隔轮询，
// 让 1~8s 快速出图的媒体不再被首轮指数退避（首退避即 8s + jitter）白等 3~11s。
const FAST_PROBE_WINDOW_MS = parseInt(process.env.POLLER_FAST_WINDOW_MS ?? "8000", 10);
const FAST_PROBE_TICK_MS = parseInt(process.env.POLLER_FAST_TICK_MS ?? "1000", 10);
const POLLER_REGISTER_PORT = parseInt(process.env.POLLER_REGISTER_PORT ?? "8082", 10);
// 硬上限（止血 2026-10-18）：waiting budget 仍是进度边界，可短暂延期继续 authoritative
// tracking；但 retry / waiting-budget 超限累计到上限后必须停 poll、投递失败终态收据，
// 禁止无限 +30min，禁止重新提交付费生成。可用 env 覆盖。
const MAX_RETRY_COUNT = parseInt(process.env.POLLER_MAX_RETRY_COUNT ?? "200", 10);
const MAX_WAITING_BUDGET_EXCEEDED = parseInt(
  process.env.POLLER_MAX_WAITING_BUDGET_EXCEEDED ?? "4",
  10,
);

try {
  new URL(GATEWAY_URL);
} catch {
  console.error(`[poller] GATEWAY_URL is unusable: ${GATEWAY_URL}. Exiting.`);
  process.exit(1);
}

// ============================================================
// Types
// ============================================================
type TaskKind = "image" | "video";

interface PendingTask {
  task_id: string;
  session_id: string;
  kind: TaskKind;
  api_key: string;
  user_id?: string;
  dedup_hash?: string;
  model?: string;
  // Price the tool already quoted (and the user already confirmed). The
  // platform's poll response does NOT include cost_coins, so without this the
  // image.done event reaches the frontend with no charge amount at all and the
  // ledger row records a spend of "undefined".
  cost_coins?: number;
  retry_count: number;
  next_attempt_at: number; // epoch ms
  deadline_at: number; // epoch ms
  created_at: number; // epoch ms（任务进入 poller 的时刻，用于前段密集快探窗口判定）
  // waiting budget 超限次数：每次 deadline 到期 +1；达 MAX_WAITING_BUDGET_EXCEEDED 即硬终止。
  waiting_budget_exceeded_count: number;
  // 硬终止后停 poll（可保留 map 防 recover 重置计数）；绝不 resubmit。
  tracking_exhausted?: boolean;
}

interface PlatformResponse {
  status?: string;
  result_url?: string;
  data?: Array<{ url?: string; videoUrl?: string; cost_coins?: number }>;
  // 实测（2026-08-27，refunded task 5c3cb311）：error 是对象
  // { code: "deadline_exceeded", message: "..." }，不是 string。
  error?: string | { code?: string; message?: string };
  cost_coins?: number;
}

interface PollResult {
  done: boolean;
  outcome?: "succeeded" | "failed";
  message?: string;
  url?: string;
  costCoins?: number;
  reason?: string;
  refunded?: boolean;
  status?: string;
  artifacts?: Array<{ url: string }>;
}

// ============================================================
// Token Bucket (sustained 54 rpm, burst-capped)
// ============================================================
// Capacity is deliberately NOT 55. A bucket that both starts full at 55 AND
// refills 55/min permits ~110 requests inside the first 60s — measured: 110
// polls in 65s with 65 queued tasks. That is nearly double the platform's
// 60rpm ceiling, so the whole point of the limiter was defeated on exactly the
// burst it exists to absorb.
//
// With capacity C and rate R, the worst case in any 60s window is C + 60R.
// C=5, R=54/60 gives 5 + 54 = 59 <= 60, so even a cold-start stampede stays
// under the ceiling while sustained throughput remains ~54rpm.
class TokenBucket {
  private readonly max = 5;
  private readonly rate = 54 / 60; // per second
  private tokens = this.max;
  private lastRefill = Date.now();

  consume(): boolean {
    const now = Date.now();
    const dt = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.max, this.tokens + dt * this.rate);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens--;
      return true;
    }
    return false;
  }

  waitMs(): number {
    return Math.ceil((1 - this.tokens) / this.rate * 1000) + 100;
  }
}

const bucket = new TokenBucket();

// ============================================================
// Pending task registry
// ============================================================
const pendingTasks = new Map<string, PendingTask>();

function registerTask(p: {
  task_id: string;
  session_id: string;
  kind: TaskKind;
  api_key: string;
  user_id?: string;
  dedup_hash?: string;
  model?: string;
  cost_coins?: number;
  created_at?: number;
}): void {
  // Image lifetime 12min：平台自身 deadline（deadline_exceeded→refunded）在
  // ~10min 落地；12min 是 poller 兜底死线——超过即按失败收尾（发帧 + 停轮询），
  // 不再无限 backoff 把节点晾在「生成中」。
  const lifetimeMin = p.kind === "video" ? 30 : 12;
  pendingTasks.set(p.task_id, {
    task_id: p.task_id,
    session_id: p.session_id,
    kind: p.kind,
    api_key: p.api_key,
    user_id: p.user_id,
    dedup_hash: p.dedup_hash,
    model: p.model,
    cost_coins: p.cost_coins,
    retry_count: 0,
    next_attempt_at: 0,
    deadline_at: Date.now() + lifetimeMin * 60_000,
    created_at: p.created_at ?? Date.now(),
    waiting_budget_exceeded_count: 0,
  });
}

// ============================================================
// Backoff helpers
// ============================================================
function baseBackoff(retryCount: number): number {
  // exponential: base 4s, max 60s
  const seconds = Math.min(60, 4 * Math.pow(2, retryCount));
  return seconds * 1000;
}

function jitter(ms: number): number {
  return ms + Math.random() * (ms * 0.5);
}

function applyBackoff(task: PendingTask, retryAfterSeconds?: number): void {
  // WP1 前段密集快探：任务创建窗口内不累加 retry_count、不做指数退避，
  // 只按快探间隔（或上游 Retry-After，若有且更大）排下一次探测；窗口过后
  // 从干净的 retry_count 开始原有指数退避语义。
  if (Date.now() - task.created_at < FAST_PROBE_WINDOW_MS) {
    const fast = retryAfterSeconds !== undefined && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : FAST_PROBE_TICK_MS;
    task.next_attempt_at = Date.now() + fast;
    return;
  }
  task.retry_count++;
  let delayMs = baseBackoff(task.retry_count);
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
    delayMs = Math.max(delayMs, retryAfterSeconds * 1000);
  }
  task.next_attempt_at = Date.now() + jitter(delayMs);
}

// ============================================================
// Per-session API key resolution
// ============================================================
const resolvedSessions = new Map<string, { api_key: string; user_id?: string }>();

async function resolveKey(session_id: string): Promise<string> {
  const cached = resolvedSessions.get(session_id);
  if (cached) return cached.api_key;
  try {
    const res = await fetch(`${GATEWAY_URL}/internal/session-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id }),
    });
    if (!res.ok) {
      throw new Error(`session-key endpoint returned ${res.status}`);
    }
    const data = (await res.json()) as { ok?: boolean; api_key?: string; user_id?: string };
    if (!data.ok || typeof data.api_key !== "string" || data.api_key.length === 0) {
      throw new Error("session-key endpoint returned no api_key");
    }
    resolvedSessions.set(session_id, { api_key: data.api_key, user_id: data.user_id });
    return data.api_key;
  } catch (err) {
    console.warn(
      `[poller] session-key resolution failed for session ${session_id}:`,
      (err as Error).message,
      "— keeping owner-scoped task pending"
    );
    throw new Error("owner-scoped session key unavailable");
  }
}

function hashId(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(36)}`;
}

// ============================================================
// Platform API call
// ============================================================
async function pollTask(task: PendingTask): Promise<PollResult> {
  // pollPathFor 回传的是公开域形状的 `/v1/images/<id>`（见 media-endpoints.ts:41-44），
  // PLATFORM_API_BASE 已含 `/image-control/api/v1`，故剥掉多余的 `/v1` 前缀，
  // 拼出 `/image-control/api/v1/images/<id>`（= Vercel 对 /v1/* 的改写目标，同一后端）。
  const url = `${PLATFORM_API_BASE}${pollPathFor(task.kind, task.task_id).replace(/^\/v1/, "")}`;

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${task.api_key}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    console.error(`[poller] network error for ${task.task_id}:`, (err as Error).message);
    applyBackoff(task);
    return { done: false };
  }

  // HTTP 429: respect Retry-After
  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get("Retry-After") ?? "");
    const seconds = Number.isFinite(retryAfter) ? retryAfter : 30;
    console.warn(`[poller] 429 for ${task.task_id}, backing off ${seconds}s`);
    applyBackoff(task, seconds);
    return { done: false };
  }

  // HTTP 5xx: retry with backoff
  if (res.status >= 500 && res.status < 600) {
    console.warn(`[poller] ${res.status} for ${task.task_id}, backing off`);
    applyBackoff(task);
    return { done: false };
  }

  // 404: task not found on platform (task likely deleted/unknown) — keep retrying with backoff
  if (res.status === 404) {
    console.warn(`[poller] 404 for ${task.task_id}, backing off`);
    applyBackoff(task);
    return { done: false };
  }

  if (!res.ok) {
    console.warn(`[poller] unexpected ${res.status} for ${task.task_id}, backing off`);
    applyBackoff(task);
    return { done: false };
  }

  let body: PlatformResponse;
  try {
    body = (await res.json()) as PlatformResponse;
  } catch (err) {
    console.error(`[poller] bad json for ${task.task_id}:`, (err as Error).message);
    applyBackoff(task);
    return { done: false };
  }

  const status = body.status;
  const costCoins =
    typeof body.cost_coins === "number"
      ? body.cost_coins
      : typeof body.data?.[0]?.cost_coins === "number"
        ? body.data?.[0]?.cost_coins
        : undefined;

  // error 字段兼容两种形状：旧 string、实测的 {code, message} 对象。
  const errorText =
    typeof body.error === "string"
      ? body.error
      : body.error && typeof body.error === "object" && typeof body.error.message === "string"
        ? body.error.message
        : undefined;

  const knownArtifacts = (body.data ?? []).map((item) => ({ ...item, url: item.url ?? item.videoUrl })).filter((item): item is { url: string } => typeof item.url === "string" && /^https?:\/\//.test(item.url));

  if (status === "succeeded") {
    // Prefer the public direct link over result_url. Two reasons result_url is
    // wrong for display: it is a RELATIVE path ("/v1/images/{id}/result"), and
    // that endpoint requires the Bearer key. Handing it to a browser produces a
    // 401 broken image. data[0].url is the absolute, publicly fetchable object.
    //
    // This ordering used to be harmless because the platform did not return
    // result_url at all; it was added by the part-1 API work, at which point the
    // old "result_url first" order silently started publishing auth-required
    // URLs. Keep the public link first.
    const publicUrl = body.data?.[0]?.url ?? body.data?.[0]?.videoUrl;
    const urlValue =
      publicUrl ??
      (typeof body.result_url === "string" && /^https?:\/\//.test(body.result_url)
        ? body.result_url
        : undefined);
    const message =
      urlValue !== undefined
        ? `任务完成：${urlValue}（task_id: ${task.task_id}）。请显示图片URL给用户，询问是否改图/放大/重生成。`
        : `任务完成（task_id: ${task.task_id}），但平台未返回 result_url。请显示任务状态给用户，询问是否改图/放大/重生成。`;
    const artifacts = knownArtifacts;
    if (!artifacts.length && urlValue) artifacts.push({ url: urlValue });
    if (!artifacts.length) { applyBackoff(task); return { done: false }; }
    return { done: true, outcome: "succeeded", status, artifacts, message, url: urlValue, costCoins };
  }

  if (status === "failed") {
    const reason = errorText ? `原因：${errorText}` : "未知原因";
    const message = `任务失败（task_id: ${task.task_id}）。${reason}。请向用户说明生成失败，询问是否重试。`;
    return { done: true, outcome: "failed", status, artifacts: knownArtifacts, message, reason: errorText ?? "未知原因" };
  }

  // refunded：平台终态（如 deadline_exceeded / overloaded 排队超时后退款）。
  // 实测响应：status="refunded"、error={code:"deadline_exceeded",message:...}。
  // 旧代码把它当「未知状态」无限 backoff——退款真实发生但用户永远看不到失败帧。
  if (status === "refunded") {
    const detail = errorText ? `（平台原因：${errorText}）` : "";
    // 2026-10-23：禁「没排上队／高峰排队」假叙事。refunded 多为供给不可用／deadline／渠道失败后退款。
    const message =
      `${task.kind === "video" ? "这部影片" : "这张图"}生成失败，费用已全额退回${detail}（task_id: ${task.task_id}）。` +
      `请用一句口语向用户说明：这次没成功、费用已退回，并主动问要不要换模型或稍后再试。禁止说「没排上队」「高峰排队」「换个时段再试」这类把供给故障说成排队的话；不要输出技术细节。`;
    return {
      done: true,
      outcome: "failed",
      message,
      reason: `已退款：${errorText ?? "平台未说明原因"}`,
      refunded: true,
      artifacts: knownArtifacts,
      status,
    };
  }
  if (status === "cancelled") return { done: true, outcome: "failed", status, artifacts: knownArtifacts, reason: errorText || "平台确认取消" };

  // "queued" / "running" / anything else: keep polling with backoff
  applyBackoff(task);
  return { done: false };
}

// ============================================================
// Main tick
// ============================================================
let lastTick = Date.now();

let ticking = false;
async function gatewayReceipt(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${GATEWAY_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.durable) throw new Error(`durable receipt unavailable (${response.status})`);
  return result;
}
let recoveredAt = 0;
async function recoverPending(): Promise<void> {
  // SQLite on the gateway is the authoritative registry; this Map is only a polling cache.
  const snapshot = await gatewayReceipt("/internal/job-pending", {});
  const active = new Set<string>();
  for (const receipt of snapshot.tasks || []) {
    active.add(receipt.task_id);
    if (pendingTasks.has(receipt.task_id)) continue;
    try {
      const credentialSession = receipt.credential_session_id || receipt.producer_oc;
      const api_key = await resolveKey(credentialSession);
      registerTask({ task_id: receipt.task_id, session_id: receipt.producer_oc, kind: receipt.kind,
        api_key, model: receipt.model, cost_coins: receipt.cost_coins, created_at: receipt.created_at });
      pendingTasks.get(receipt.task_id)!.deadline_at = receipt.created_at + (receipt.kind === "video" ? 30 : 12) * 60000;
      if (["failed", "refunded", "cancelled"].includes(receipt.status)) pendingTasks.get(receipt.task_id)!.next_attempt_at = Date.now() + 10 * 60000;
    } catch { console.warn(`[poller] task ${receipt.task_id} owner resolution deferred; durable receipt retained`); }
  }
  for (const id of pendingTasks.keys()) if (!active.has(id)) pendingTasks.delete(id);
  recoveredAt = Date.now();
}
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  lastTick = Date.now();
  try {
    if (Date.now() - recoveredAt > 30000) await recoverPending();
    for (const [id, task] of pendingTasks) {
      lastTick = Date.now();
      const now = Date.now();
      // 硬终止后停 poll：已投递失败收据；禁止 resubmit；不因 recover 再开无限 tracking。
      if (task.tracking_exhausted) continue;
      // Waiting budget 仍是进度边界（可有限次延期继续 authoritative tracking），
      // 但不再无限 +30min；累计超限或 retry 触顶 → 硬终止。
      if (
        now >= task.deadline_at &&
        task.waiting_budget_exceeded_count < MAX_WAITING_BUDGET_EXCEEDED
      ) {
        task.waiting_budget_exceeded_count++;
        if (task.waiting_budget_exceeded_count < MAX_WAITING_BUDGET_EXCEEDED) {
          console.warn(
            `[poller] task ${id} exceeded waiting budget ` +
              `(${task.waiting_budget_exceeded_count}/${MAX_WAITING_BUDGET_EXCEEDED}); ` +
              `continuing authoritative tracking (progress boundary only; not infinite)`,
          );
          task.deadline_at = now + 30 * 60000;
        }
        // else: 计数已达上限，不延期；下方 hardStop 投递失败收据并停 poll。
      }
      const hardStop =
        task.retry_count >= MAX_RETRY_COUNT ||
        task.waiting_budget_exceeded_count >= MAX_WAITING_BUDGET_EXCEEDED;
      if (hardStop) {
        const reason =
          `poller hard stop: retry_count=${task.retry_count}/${MAX_RETRY_COUNT}, ` +
          `waiting_budget_exceeded=${task.waiting_budget_exceeded_count}/${MAX_WAITING_BUDGET_EXCEEDED} ` +
          `(stop poll; no resubmit; billing unchanged)`;
        console.warn(`[poller] task ${id} ${reason}`);
        try {
          await gatewayReceipt("/internal/job-completion", {
            task_id: id,
            status: "failed",
            artifacts: [],
            reason,
          });
          // 停 poll；保留 map 条目避免 recover 把计数清零后重开无限跟踪。禁止重新提交生成。
          task.tracking_exhausted = true;
          task.next_attempt_at = Number.MAX_SAFE_INTEGER;
        } catch (error) {
          applyBackoff(task);
          console.warn(`[poller] task ${id} hard-stop handoff deferred:`, (error as Error).message);
        }
        continue;
      }
      if (task.next_attempt_at > now || !bucket.consume()) continue;
      console.log(`[poller] polling ${task.kind} ${id} (retry #${task.retry_count})`);
      const result = await pollTask(task);
      if (!result.done) continue;
      try {
        await gatewayReceipt("/internal/job-completion", { task_id: id, status: result.status,
          artifacts: result.artifacts || [], reason: result.reason, cost_coins: result.costCoins ?? task.cost_coins });
        // Delete cache only AFTER terminal result and its unread consumer inbox are durably handed off.
        if (result.status === "succeeded") pendingTasks.delete(id);
        else task.next_attempt_at = Date.now() + 10 * 60000; // Reconcile original ID for late success; never resubmit generation.
      } catch (error) {
        applyBackoff(task);
        console.warn(`[poller] task ${id} durable handoff deferred:`, (error as Error).message);
      }
    }
  } catch (error) {
    console.warn("[poller] durable recovery deferred:", (error as Error).message);
  } finally { ticking = false; lastTick = Date.now(); }
}

// ============================================================
// Watchdog: if last tick >60s ago, exit (systemd revives)
// ============================================================
setInterval(() => {
  const elapsed = Date.now() - lastTick;
  if (elapsed > 60_000) {
    console.error(`[poller] watchdog: no tick in ${elapsed}ms (>60s). Exiting.`);
    process.exit(1);
  }
}, 30_000);

// ============================================================
// HTTP register server
// ============================================================
const server = serve({
  port: POLLER_REGISTER_PORT,
  // Loopback only: the register endpoint has no auth by design (it trusts
  // in-process callers), so it must never be reachable off-host.
  hostname: "127.0.0.1",
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path === "/") {
      try {
        const body = (await req.json()) as {
          task_id?: string;
          session_id?: string;
          kind?: TaskKind;
          dedup_hash?: string;
          model?: string;
          // Estimated cost from the tool, computed off the live catalog. The
          // platform's poll response carries no cost_coins at all (verified),
          // so without this image.done would ship cost: null and the frontend
          // could never show what the user was charged.
          cost_coins?: number;
        };
        if (!body.task_id || !body.session_id) {
          return Response.json({ ok: false, error: "task_id and session_id are required" }, { status: 400 });
        }
        if (body.kind !== "image" && body.kind !== "video") {
          return Response.json({ ok: false, error: "kind must be 'image' or 'video'" }, { status: 400 });
        }

        // This endpoint runs AFTER upstream acceptance. A cache hit must never hide the new accepted job.
        await gatewayReceipt("/internal/job-register", body);
        const api_key = await resolveKey(body.session_id);
        const keyEntry = resolvedSessions.get(body.session_id);
        const user_id = keyEntry?.user_id;

        registerTask({
          task_id: body.task_id,
          session_id: body.session_id,
          kind: body.kind,
          api_key,
          user_id,
          dedup_hash: body.dedup_hash,
          model: body.model,
          cost_coins: typeof body.cost_coins === "number" ? body.cost_coins : undefined,
        });
        console.log(
          `[poller] registered ${body.kind} task ${body.task_id} for session ${body.session_id}` +
            (user_id !== undefined ? ` (user ${hashId(user_id)})` : "")
        );
        return Response.json({ ok: true, durable: true });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 400 });
      }
    }

    if (req.method === "GET" && path === "/") {
      return Response.json({
        pending: pendingTasks.size,
        tasks: [...pendingTasks.keys()],
      });
    }

    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  },
});

// ============================================================
// Startup
// ============================================================
console.log(`[poller] register server on :${POLLER_REGISTER_PORT}`);
console.log(`[poller] gateway ${GATEWAY_URL}, tick ${POLLER_TICK_MS}ms, fast probe window ${FAST_PROBE_WINDOW_MS}ms @ ${FAST_PROBE_TICK_MS}ms, api ${PLATFORM_API_BASE}, max_retry=${MAX_RETRY_COUNT}, max_waiting_budget_exceeded=${MAX_WAITING_BUDGET_EXCEEDED}`);

setInterval(tick, Math.min(POLLER_TICK_MS, FAST_PROBE_TICK_MS)).unref?.();
void tick(); // run immediately at startup
