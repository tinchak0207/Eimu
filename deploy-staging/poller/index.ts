import { serve } from "bun";
import { doneEventFor, pollPathFor } from "./media-endpoints";

// ============================================================
// Configuration
// ============================================================
const HARNESS_API_KEY = process.env.HARNESS_API_KEY;
const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:8081";
const POLLER_TICK_MS = parseInt(process.env.POLLER_TICK_MS ?? "4000", 10);
const POLLER_REGISTER_PORT = parseInt(process.env.POLLER_REGISTER_PORT ?? "8082", 10);

if (!HARNESS_API_KEY) {
  console.warn("[poller] HARNESS_API_KEY not set — per-session keys will be used, fallback will be empty");
}

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
}

interface DedupEntry {
  url: string;
  task_id: string;
  cost_coins?: number;
  ts: number;
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
      "— falling back to HARNESS_API_KEY"
    );
    return HARNESS_API_KEY ?? "";
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
  const url = `https://image.tinchak0207.xyz${pollPathFor(task.kind, task.task_id)}`;

  let res: Response;
  try {
    res = await fetch(url, {
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
        ? `任務完成：${urlValue}（task_id: ${task.task_id}）。請顯示圖片URL給用戶，詢問是否改圖/放大/重生成。`
        : `任務完成（task_id: ${task.task_id}），但平台未返回 result_url。請顯示任務狀態給用戶，詢問是否改圖/放大/重生成。`;
    return { done: true, outcome: "succeeded", message, url: urlValue, costCoins };
  }

  if (status === "failed") {
    const reason = errorText ? `原因：${errorText}` : "未知原因";
    const message = `任務失敗（task_id: ${task.task_id}）。${reason}。請向用戶說明生成失敗，詢問是否重試。`;
    return { done: true, outcome: "failed", message, reason: errorText ?? "未知原因" };
  }

  // refunded：平台终态（如 deadline_exceeded / overloaded 排队超时后退款）。
  // 实测响应：status="refunded"、error={code:"deadline_exceeded",message:...}。
  // 旧代码把它当「未知状态」无限 backoff——退款真实发生但用户永远看不到失败帧。
  if (status === "refunded") {
    const detail = errorText ? `（平台原因：${errorText}）` : "";
    const message =
      `${task.kind === "video" ? "這部影片" : "這張圖"}沒排上隊，費用已全額退回${detail}（task_id: ${task.task_id}）。` +
      `請用一句口語向用戶說明：這次生成沒成功、費用已退回，並主動問要不要換個時段或換個模型重試。不要輸出技術細節。`;
    return {
      done: true,
      outcome: "failed",
      message,
      reason: `已退款：${errorText ?? "平台未说明原因"}`,
      refunded: true,
    };
  }

  // "queued" / "running" / anything else: keep polling with backoff
  applyBackoff(task);
  return { done: false };
}

// ============================================================
// Gateway event emit (fire-and-forget)
// ============================================================
async function emitEvent(session_id: string, event: string, data: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${GATEWAY_URL}/internal/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id, event, data }),
    });
    if (!res.ok) {
      console.error(`[poller] emit ${event} failed (${res.status}) for session ${session_id}`);
    } else {
      console.log(`[poller] emitted ${event} for session ${session_id}`);
    }
  } catch (err) {
    console.error(`[poller] emit ${event} error for ${session_id}:`, (err as Error).message);
  }
}

// ============================================================
// Dedup cache (PRD §437)
// ============================================================
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUP_MAX = 500;
const dedupCache = new Map<string, DedupEntry>();

function getDedup(hash: string): DedupEntry | undefined {
  const entry = dedupCache.get(hash);
  if (entry === undefined) return undefined;
  if (Date.now() - entry.ts > DEDUP_TTL_MS) {
    dedupCache.delete(hash);
    return undefined;
  }
  return entry;
}

function recordDedup(hash: string, entry: { url: string; task_id: string; cost_coins?: number }): void {
  dedupCache.set(hash, { ...entry, ts: Date.now() });
  if (dedupCache.size <= DEDUP_MAX) return;
  let oldestKey: string | undefined;
  let oldestTs = Infinity;
  for (const [k, v] of dedupCache) {
    if (v.ts < oldestTs) {
      oldestTs = v.ts;
      oldestKey = k;
    }
  }
  if (oldestKey !== undefined) dedupCache.delete(oldestKey);
}

// ============================================================
// Task failure fan-out：会话级错误帧 + 节点级失败帧（与 image.done 对称）
// ============================================================
function emitTaskFailure(session_id: string, task_id: string, reason: string, refunded: boolean): void {
  void emitEvent(session_id, "session.error", {
    code: refunded ? "task_refunded" : "task_failed",
    message: reason,
  });
  void emitEvent(session_id, "image.failed", {
    task_id,
    reason,
    refunded,
  });
}

// ============================================================
// Gateway resume
// ============================================================
async function resumeSession(session_id: string, content: string): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_URL}/internal/resume-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id, content }),
    });
    if (res.status === 404) {
      console.log(`[poller] session ${session_id} is gone (404); task dropped, no one listening`);
      return false;
    }
    if (!res.ok) {
      console.error(`[poller] resume-session failed (${res.status}) for session ${session_id}`);
      return false;
    }
    console.log(`[poller] resumed session ${session_id}`);
    return true;
  } catch (err) {
    console.error(`[poller] resume-session error for ${session_id}:`, (err as Error).message);
    return false;
  }
}

// ============================================================
// Main tick
// ============================================================
let lastTick = Date.now();

async function tick(): Promise<void> {
  lastTick = Date.now();
  const now = Date.now();

  for (const [id, task] of pendingTasks) {
    // Lifetime cap: images 12 min（对齐平台 deadline）, videos 30 min。
    // 超时按失败收尾：发 image.failed 帧 + 人话 resume，节点不再卡「生成中」。
    if (now >= task.deadline_at) {
      pendingTasks.delete(id);
      const lifetimeMin = task.kind === "video" ? 30 : 12;
      console.warn(`[poller] task ${id} exceeded ${lifetimeMin}min lifetime, timing out`);
      emitTaskFailure(task.session_id, id, `任務逾時（超過 ${lifetimeMin} 分鐘未完成）`, false);
      await resumeSession(
        task.session_id,
        `${task.kind === "video" ? "這部影片" : "這張圖"}等了 ${lifetimeMin} 分鐘還沒生成完，先不讓用戶乾等了（task_id: ${task.task_id}）。` +
          `請向用戶口語說明這次生成超時，若平台後續退款會自動退回，並詢問要不要重試一次。`
      );
      continue;
    }

    if (task.next_attempt_at > now) continue; // still in backoff

    // Acquire token bucket permit
    if (!bucket.consume()) {
      // no permit yet; leave task for next tick
      continue;
    }

    console.log(`[poller] polling ${task.kind} ${id} (retry #${task.retry_count})`);
    const result = await pollTask(task);

    if (!result.done) continue;

    pendingTasks.delete(id);

    if (result.outcome === "succeeded") {
      if (result.url !== undefined) {
        // Prefer the platform's authoritative cost; fall back to the estimate the
        // tool computed at submit time. Verified: the platform poll response
        // carries no cost_coins field, so without the fallback every image.done
        // reached the frontend with no charge amount and the ledger row had none
        // either — the user could never see what a generation actually cost.
        const cost = result.costCoins ?? task.cost_coins;
        const emitData: Record<string, unknown> = { url: result.url, task_id: id };
        if (cost !== undefined) emitData.cost_coins = cost;
        if (task.kind === "video") emitData.media_kind = "video";
        void emitEvent(task.session_id, doneEventFor(task.kind), emitData);
        if (task.dedup_hash !== undefined) {
          recordDedup(task.dedup_hash, { url: result.url, task_id: id, cost_coins: cost });
        }
      }
    } else if (result.outcome === "failed") {
      // 失败也要推节点级帧：与 image.done 对称，前端据此把节点置 error 态。
      emitTaskFailure(task.session_id, id, result.reason ?? "未知原因", result.refunded === true);
    }

    if (result.message !== undefined) {
      await resumeSession(task.session_id, result.message);
    }
  }
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

        if (typeof body.dedup_hash === "string" && body.dedup_hash.length > 0) {
          const cached = getDedup(body.dedup_hash);
          if (cached) {
            console.log(`[poller] dedup hit for session ${body.session_id}, reusing result ${cached.task_id}`);
            void emitEvent(body.session_id, "image.done", {
              url: cached.url,
              cost_coins: 0,
              task_id: cached.task_id,
            });
            const msg =
              `偵測到完全相同的請求，已直接從快取回傳先前結果，0 幣耗費。\n` +
              `結果：${cached.url}（task_id: ${cached.task_id}）。\n請顯示圖片URL給用戶，詢問是否改圖/放大/重生成。`;
            await resumeSession(body.session_id, msg);
            return Response.json({ ok: true, deduped: true, url: cached.url });
          }
        }

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
        return Response.json({ ok: true });
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
console.log(`[poller] gateway ${GATEWAY_URL}, tick ${POLLER_TICK_MS}ms`);

setInterval(tick, POLLER_TICK_MS).unref?.();
void tick(); // run immediately at startup
