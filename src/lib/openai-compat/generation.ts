// OpenAI 兼容层（`/openai/v1/*`）的 **durable 生成桥**：提交 → 轮询 → 取件。
//
// 为什么不直接 import `@/lib/generation-core/*`（submitGenerationCommand /
// getGenerationJobForTenant）：`/openai/v1/*` 是站点 repo 的路由，生产跑在 Vercel，而
// Vercel 按设计**不持有 GENERATION_DATABASE_URL**——任何直连 job-repository 的调用首次
// 触库就抛错（2026-08-21 实测：成功任务与不存在任务一并 500）。所以提交与轮询一律走
// **既有被代理的 HTTP 入口**（`next.config.mjs` beforeFiles 把 `/api/v1/*` 代理到控制面
// `/image-control/api/v1/*`）：
//
//   POST /api/v1/images/generations  → 202 { id, status:"queued", … }
//   GET  /api/v1/images/{id}         → { status, data:[{url,mimeType,…}] }（succeeded 才有 data）
//
// b64_json 也复用同一条交付 URL：先问既有取件后端（`src/lib/blob-backend.ts` 的
// `get()`，Vercel Blob 或 VPS blob adapter），取不到再直接 HTTP 取——不另造第二套储存。
//
// 等待上限：见 `MAX_WAIT_MS`。超时不取消任务（任务仍在控制面后台跑），由呼叫端回 504
// 并把 task id 交给客户。
import { get as blobGet } from "@/lib/blob-backend";
import { sanitizeUpstreamMessage } from "@/lib/upstream-sanitizer";
import { type OpenAICompatErrorType, type OpenAIErrorFields, readUpstreamError } from "./errors";

/** 站内 durable 提交入口（控制面代理路径）。 */
export const SUBMIT_PATH = "/api/v1/images/generations";

/** 任务查询入口；`id` 由上游产生（uuid），仍做编码避免路径注入。 */
export function taskPath(taskId: string): string {
  return `/api/v1/images/${encodeURIComponent(taskId)}`;
}

/**
 * 服务端等待上限（ms）。
 *
 * 事实依据：`vercel.json` 没有任何 `functions.maxDuration` 覆写；站内 B 端/生图路由
 * 一律自带 `export const maxDuration = 300`（`src/app/api/v1/images/generations/route.ts:39`
 * 等 8 处）。因此本层也取 300s 函数预算，并留 60s 给响应落盘与退款结算
 * （同 `src/app/api/generate-images/route.ts` 的「UPSTREAM_BUDGET + 结算余裕」惯例），
 * 得 240s 等待上限。超过＝回 504，任务继续在后台跑。
 *
 * **这条路由跑在哪里决定了 240s 是否真的可用**：本专案的 Vercel 是 Hobby
 * （`docs/ARCHITECTURE.md` 记「Hobby 限每日一次」），Hobby 的函数硬上限是 60s——
 * `maxDuration=300` 会被平台夹到 60s，等待中的函数直接硬杀（连 504 都送不出去）。
 * 因此 `/openai/v1/*` 的目标承载是**控制面**（VPS 上的 standalone node server，无函数
 * 时长概念，且持有 GENERATION_DATABASE_URL 让熔断闸真的生效）：加一条
 * `beforeFiles` 代理 + 搬档即可。若暂时留在 Vercel，必须设
 * `OPENAI_COMPAT_MAX_WAIT_MS=45000`，用干净的 504（讯息带 task id）取代硬杀。
 */
export const MAX_WAIT_MS = 240_000;

/** Vercel 硬杀函数的预算（与站内 B 端路由同值），仅作为常数与 maxDuration 对齐用。 */
export const FUNCTION_MAX_DURATION_SECONDS = 300;

/**
 * 等待上限的有效值。
 *
 * `OPENAI_COMPAT_MAX_WAIT_MS` 是给「函数预算小于 300s 的承载」用的旋钮：同一份代码搬到
 * 只给 60s 的函数方案时，把上限设成 45_000 就不会被平台硬杀（硬杀会连 504 都送不出去）。
 * 未设＝240s。非法值（0/负/NaN）一律忽略，不让环境变数把等待变成 0。
 */
export function resolveMaxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OPENAI_COMPAT_MAX_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MAX_WAIT_MS;
}

const POLL_INTERVAL_MS = 2_500;
const POLL_INTERVAL_MAX_MS = 5_000;
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_REQUEST_TIMEOUT_MS = 15_000;
const ARTIFACT_TIMEOUT_MS = 30_000;

const TERMINAL_STATUSES = new Set(["failed", "cancelled", "refunded", "unknown"]);

export interface CompatArtifact {
  id?: string;
  url?: string;
  mimeType?: string;
}

export type TaskOutcome =
  | { status: "succeeded"; artifacts: CompatArtifact[] }
  | { status: "failed" | "cancelled" | "refunded" | "unknown"; message: string; code: string };

/**
 * 提交/轮询打哪个 origin。
 *
 * 预设＝当前请求自己的 origin：在 Vercel 上请求 origin 就是公开域，`/api/v1/*` 命中
 * beforeFiles 代理 → 控制面（与客户直打 /v1 走同一条路）。控制面自己承载这几条路由时，
 * 用 `OPENAI_COMPAT_GENERATION_ORIGIN=http://127.0.0.1:3000` 直连本机，免绕回 Vercel。
 */
export function resolveGenerationOrigin(requestUrl: string): string {
  const override = process.env.OPENAI_COMPAT_GENERATION_ORIGIN?.trim();
  if (override) return override.replace(/\/$/, "");
  return new URL(requestUrl).origin;
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  return present[0];
}

export interface SubmitImageInput {
  origin: string;
  authorization: string | null;
  model: string;
  prompt: string;
  n: number;
  size: string;
  /** OpenAI 的 quality（`hd`/`high` 走 quality，其余 fast），原样透传给站内入口。 */
  quality?: string;
  idempotencyKey?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type SubmitImageResult =
  | { ok: true; taskId: string }
  | { ok: false; error: OpenAIErrorFields };

export async function submitImageTask(input: SubmitImageInput): Promise<SubmitImageResult> {
  const fetcher = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.authorization) headers.authorization = input.authorization;
  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  let upstream: Response;
  try {
    upstream = await fetcher(new URL(SUBMIT_PATH, `${input.origin}/`).toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        n: input.n,
        size: input.size,
        // 交付形式在这一层才决定（b64 由本层取件编码）；durable 任务的产物一律是 URL，
        // 所以送 url 才是诚实的 request_config（与 /api/generation-jobs 的 web 入口同值）。
        response_format: "url",
        ...(input.quality ? { quality: input.quality } : {}),
      }),
      cache: "no-store",
      signal: mergeSignals(AbortSignal.timeout(SUBMIT_TIMEOUT_MS), input.signal),
    });
  } catch {
    return {
      ok: false,
      error: {
        status: 503,
        message: "生成控制面暂时不可达，请稍后重试。",
        type: "api_error",
        code: "control_plane_unreachable",
      },
    };
  }

  if (!upstream.ok) {
    return {
      ok: false,
      error: await readUpstreamError(upstream, { message: "提交生成任务失败。", code: "task_submission_failed" }),
    };
  }

  const payload = (await upstream.json().catch(() => null)) as { id?: unknown; task_id?: unknown } | null;
  const taskId =
    typeof payload?.id === "string" && payload.id
      ? payload.id
      : typeof payload?.task_id === "string"
        ? payload.task_id
        : "";
  if (!taskId) {
    return {
      ok: false,
      error: { status: 502, message: "生成控制面未返回任务 ID。", type: "api_error", code: "task_id_missing" },
    };
  }
  return { ok: true, taskId };
}

interface TaskSnapshot {
  status: string;
  artifacts: CompatArtifact[];
  message: string;
  code: string;
}

/** 单次任务读取；网路抖动/非 2xx/形状异常 → null（呼叫端据此重试，不当终态）。 */
async function readTaskSnapshot(
  fetcher: typeof fetch,
  input: { origin: string; authorization: string | null; taskId: string },
): Promise<TaskSnapshot | null> {
  try {
    const headers: Record<string, string> = {};
    if (input.authorization) headers.authorization = input.authorization;
    const response = await fetcher(new URL(taskPath(input.taskId), `${input.origin}/`).toString(), {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      status?: unknown;
      data?: unknown;
      error?: { code?: unknown; message?: unknown } | null;
    };
    const status = typeof payload.status === "string" ? payload.status : "";
    if (!status) return null;
    const artifacts = Array.isArray(payload.data)
      ? payload.data
          .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
          .map((item) => ({
            ...(typeof item.id === "string" ? { id: item.id } : {}),
            ...(typeof item.url === "string" ? { url: item.url } : {}),
            ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
          }))
      : [];
    const rawMessage =
      typeof payload.error?.message === "string" && payload.error.message
        ? payload.error.message
        : "生成失败，未出图（未扣费）。";
    return {
      status,
      artifacts,
      // 控面任务 API 的错误 message 可能夹带内部实作细节；`/openai/v1/*` 是
      // DURABLE_PASS_THROUGH 路径（middleware 层受 Edge 25s 首字节硬限无法代收），
      // 故在此（生成源）洗，正常业务文案原样保留。
      message: sanitizeUpstreamMessage(rawMessage) ?? "生成失败，未出图（未扣费）。",
      code: typeof payload.error?.code === "string" && payload.error.code ? payload.error.code : "",
    };
  } catch {
    return null;
  }
}

export interface AwaitImageTaskInput {
  origin: string;
  authorization: string | null;
  taskId: string;
  /** 绝对截止时间（`now()` 同一基准）。 */
  deadlineAt: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type AwaitImageTaskResult =
  | { settled: true; outcome: TaskOutcome }
  | { settled: false };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询到终态或截止时间。
 *
 * 首次读取立即发生（快任务不必等一个间隔）；之后间隔 2.5s 起、每次 1.5 倍、封顶 5s。
 * 单次读取失败（控制面瞬断 / 5xx）只拉长间隔，不终结——终结只能来自 job 终态或截止。
 */
export async function awaitImageTask(input: AwaitImageTaskInput): Promise<AwaitImageTaskResult> {
  const fetcher = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? defaultSleep;
  let interval = POLL_INTERVAL_MS;

  for (;;) {
    const remaining = input.deadlineAt - now();
    if (remaining <= 0) return { settled: false };

    const snapshot = await readTaskSnapshot(fetcher, input);
    if (snapshot) {
      if (snapshot.status === "succeeded") {
        return { settled: true, outcome: { status: "succeeded", artifacts: snapshot.artifacts } };
      }
      if (TERMINAL_STATUSES.has(snapshot.status)) {
        return {
          settled: true,
          outcome: {
            status: snapshot.status as "failed" | "cancelled" | "refunded" | "unknown",
            message: snapshot.message,
            code: snapshot.code,
          },
        };
      }
      interval = POLL_INTERVAL_MS;
    } else {
      interval = Math.min(Math.round(interval * 1.5), POLL_INTERVAL_MAX_MS);
    }

    const wait = Math.min(interval, Math.max(0, input.deadlineAt - now()));
    if (wait <= 0) return { settled: false };
    await sleep(wait);
  }
}

/**
 * 任务终态 → OpenAI 错误栏位。
 *
 * 未出图＝未扣费（durable 管线对未完成张数自动退款，compat 层不碰帐本，只把真实原因
 * 与 task id 交出去，客户能在网页历史里找到该任务）。
 */
export function taskFailureToError(
  outcome: Extract<TaskOutcome, { status: "failed" | "cancelled" | "refunded" | "unknown" }>,
  taskId: string,
): OpenAIErrorFields {
  const status: number =
    outcome.status === "cancelled" ? 400 : outcome.status === "unknown" ? 503 : 502;
  const type: OpenAICompatErrorType = status === 400 ? "invalid_request_error" : "api_error";
  return {
    status,
    type,
    // 上游的稳定码（job.failureClass，如 overloaded）优先透传：客户要能分辨失败原因。
    code: outcome.code || (outcome.status === "failed" ? "generation_failed" : `generation_${outcome.status}`),
    message: `${outcome.message}（任务 ${taskId} 未出图，未扣费）`,
  };
}

/** 超时（504）：任务仍在后台跑，把 task id 与查询入口交给客户。 */
export function taskTimeoutError(taskId: string): OpenAIErrorFields {
  return {
    status: 504,
    type: "api_error",
    code: "generation_timeout",
    message: `生成超时：任务 ${taskId} 仍在后台运行，可稍后在任务历史中查看结果；本次未出图不扣费。`,
  };
}

/** 既有取件后端的最小介面（`blob-backend.get` 的子集），测试可注入替身。 */
export interface ArtifactBlobGet {
  (url: string, options: { access: "public" }): Promise<{
    statusCode: number;
    stream: ReadableStream<Uint8Array> | null;
  } | null>;
}

export interface ArtifactFetchDeps {
  fetchImpl?: typeof fetch;
  blobGetImpl?: ArtifactBlobGet;
}

/**
 * 取回交付产物的位元组。
 *
 * ① 既有取件后端：交付 URL 多数是 `blob-backend.put()` 存进去的物件（Vercel Blob 或
 *    VPS blob adapter），走同一条 `get()` 拿 stream；
 * ② 非 blob URL（上游直链交付）或后端未配置/未授权 → 直接 HTTP 取。
 * 两条路都只读，不写任何储存。
 */
export async function readArtifactBytes(url: string, deps: ArtifactFetchDeps = {}): Promise<Uint8Array> {
  const blobGetImpl = deps.blobGetImpl ?? ((target: string, options: { access: "public" }) => blobGet(target, options));
  try {
    const blob = await blobGetImpl(url, { access: "public" });
    if (blob && blob.statusCode >= 200 && blob.statusCode < 300 && blob.stream) {
      return new Uint8Array(await new Response(blob.stream).arrayBuffer());
    }
  } catch {
    // 落到 ②
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`artifact fetch failed HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** `b64_json` 的实际编码点：交付 URL → base64（不带 data: 前缀，OpenAI 语义）。 */
export async function artifactToBase64(url: string, deps: ArtifactFetchDeps = {}): Promise<string> {
  return Buffer.from(await readArtifactBytes(url, deps)).toString("base64");
}
