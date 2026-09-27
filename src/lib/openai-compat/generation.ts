// OpenAI 兼容層（`/openai/v1/*`）的 **durable 生成橋**：提交 → 輪詢 → 取件。
//
// 為什麼不直接 import `@/lib/generation-core/*`（submitGenerationCommand /
// getGenerationJobForTenant）：`/openai/v1/*` 是站點 repo 的路由，生產跑在 Vercel，而
// Vercel 按設計**不持有 GENERATION_DATABASE_URL**——任何直連 job-repository 的調用首次
// 觸庫就拋錯（2026-08-21 實測：成功任務與不存在任務一併 500）。所以提交與輪詢一律走
// **既有被代理的 HTTP 入口**（`next.config.mjs` beforeFiles 把 `/api/v1/*` 代理到控制面
// `/image-control/api/v1/*`）：
//
//   POST /api/v1/images/generations  → 202 { id, status:"queued", … }
//   GET  /api/v1/images/{id}         → { status, data:[{url,mimeType,…}] }（succeeded 才有 data）
//
// b64_json 也複用同一條交付 URL：先問既有取件後端（`src/lib/blob-backend.ts` 的
// `get()`，Vercel Blob 或 VPS blob adapter），取不到再直接 HTTP 取——不另造第二套儲存。
//
// 等待上限：見 `MAX_WAIT_MS`。超時不取消任務（任務仍在控制面後台跑），由呼叫端回 504
// 並把 task id 交給客戶。
import { get as blobGet } from "@/lib/blob-backend";
import { type OpenAICompatErrorType, type OpenAIErrorFields, readUpstreamError } from "./errors";

/** 站內 durable 提交入口（控制面代理路徑）。 */
export const SUBMIT_PATH = "/api/v1/images/generations";

/** 任務查詢入口；`id` 由上游產生（uuid），仍做編碼避免路徑注入。 */
export function taskPath(taskId: string): string {
  return `/api/v1/images/${encodeURIComponent(taskId)}`;
}

/**
 * 服務端等待上限（ms）。
 *
 * 事實依據：`vercel.json` 沒有任何 `functions.maxDuration` 覆寫；站內 B 端/生圖路由
 * 一律自帶 `export const maxDuration = 300`（`src/app/api/v1/images/generations/route.ts:39`
 * 等 8 處）。因此本層也取 300s 函數預算，並留 60s 給響應落盤與退款結算
 * （同 `src/app/api/generate-images/route.ts` 的「UPSTREAM_BUDGET + 結算餘裕」慣例），
 * 得 240s 等待上限。超過＝回 504，任務繼續在後台跑。
 *
 * **這條路由跑在哪裡決定了 240s 是否真的可用**：本專案的 Vercel 是 Hobby
 * （`docs/ARCHITECTURE.md` 記「Hobby 限每日一次」），Hobby 的函數硬上限是 60s——
 * `maxDuration=300` 會被平台夾到 60s，等待中的函數直接硬殺（連 504 都送不出去）。
 * 因此 `/openai/v1/*` 的目標承載是**控制面**（VPS 上的 standalone node server，無函數
 * 時長概念，且持有 GENERATION_DATABASE_URL 讓熔斷閘真的生效）：加一條
 * `beforeFiles` 代理 + 搬檔即可。若暫時留在 Vercel，必須設
 * `OPENAI_COMPAT_MAX_WAIT_MS=45000`，用乾淨的 504（訊息帶 task id）取代硬殺。
 */
export const MAX_WAIT_MS = 240_000;

/** Vercel 硬殺函數的預算（與站內 B 端路由同值），僅作為常數與 maxDuration 對齊用。 */
export const FUNCTION_MAX_DURATION_SECONDS = 300;

/**
 * 等待上限的有效值。
 *
 * `OPENAI_COMPAT_MAX_WAIT_MS` 是給「函數預算小於 300s 的承載」用的旋鈕：同一份代碼搬到
 * 只給 60s 的函數方案時，把上限設成 45_000 就不會被平台硬殺（硬殺會連 504 都送不出去）。
 * 未設＝240s。非法值（0/負/NaN）一律忽略，不讓環境變數把等待變成 0。
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
 * 提交/輪詢打哪個 origin。
 *
 * 預設＝當前請求自己的 origin：在 Vercel 上請求 origin 就是公開域，`/api/v1/*` 命中
 * beforeFiles 代理 → 控制面（與客戶直打 /v1 走同一條路）。控制面自己承載這幾條路由時，
 * 用 `OPENAI_COMPAT_GENERATION_ORIGIN=http://127.0.0.1:3000` 直連本機，免繞回 Vercel。
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
  /** OpenAI 的 quality（`hd`/`high` 走 quality，其餘 fast），原樣透傳給站內入口。 */
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
        // 交付形式在這一層才決定（b64 由本層取件編碼）；durable 任務的產物一律是 URL，
        // 所以送 url 才是誠實的 request_config（與 /api/generation-jobs 的 web 入口同值）。
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

/** 單次任務讀取；網路抖動/非 2xx/形狀異常 → null（呼叫端據此重試，不當終態）。 */
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
    return {
      status,
      artifacts,
      message:
        typeof payload.error?.message === "string" && payload.error.message
          ? payload.error.message
          : "生成失败，未出图（未扣费）。",
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
  /** 絕對截止時間（`now()` 同一基準）。 */
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
 * 輪詢到終態或截止時間。
 *
 * 首次讀取立即發生（快任務不必等一個間隔）；之後間隔 2.5s 起、每次 1.5 倍、封頂 5s。
 * 單次讀取失敗（控制面瞬斷 / 5xx）只拉長間隔，不終結——終結只能來自 job 終態或截止。
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
 * 任務終態 → OpenAI 錯誤欄位。
 *
 * 未出圖＝未扣費（durable 管線對未完成張數自動退款，compat 層不碰帳本，只把真實原因
 * 與 task id 交出去，客戶能在網頁歷史裡找到該任務）。
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
    // 上游的穩定碼（job.failureClass，如 overloaded）優先透傳：客戶要能分辨失敗原因。
    code: outcome.code || (outcome.status === "failed" ? "generation_failed" : `generation_${outcome.status}`),
    message: `${outcome.message}（任务 ${taskId} 未出图，未扣费）`,
  };
}

/** 超時（504）：任務仍在後台跑，把 task id 與查詢入口交給客戶。 */
export function taskTimeoutError(taskId: string): OpenAIErrorFields {
  return {
    status: 504,
    type: "api_error",
    code: "generation_timeout",
    message: `生成超时：任务 ${taskId} 仍在后台运行，可稍后在任务历史中查看结果；本次未出图不扣费。`,
  };
}

/** 既有取件後端的最小介面（`blob-backend.get` 的子集），測試可注入替身。 */
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
 * 取回交付產物的位元組。
 *
 * ① 既有取件後端：交付 URL 多數是 `blob-backend.put()` 存進去的物件（Vercel Blob 或
 *    VPS blob adapter），走同一條 `get()` 拿 stream；
 * ② 非 blob URL（上游直鏈交付）或後端未配置/未授權 → 直接 HTTP 取。
 * 兩條路都只讀，不寫任何儲存。
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

/** `b64_json` 的實際編碼點：交付 URL → base64（不帶 data: 前綴，OpenAI 語義）。 */
export async function artifactToBase64(url: string, deps: ArtifactFetchDeps = {}): Promise<string> {
  return Buffer.from(await readArtifactBytes(url, deps)).toString("base64");
}
