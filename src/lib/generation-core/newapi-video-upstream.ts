import { SupplierRequestError } from "./failure-classifier";
import type { ProviderTaskPollResult, SupplierGenerationInput, SupplierGenerationOutput } from "./types";

// new-api 原生视频任务内核封装（P1「任务语义归一 new-api」核心刀，2026-08-28）。
//
// new-api v1.0.0-rc.21 原生异步视频 relay（路由与回应形状对照上游源码实测，
// 见 surgery/newapi-kernel-intel.md；渠道 8 metaso-hailuo-bridge 已 relay 出真片）：
//   POST {base}/video/generations            提交 → OpenAI video 形状 {id, task_id, ...}
//   GET  {base}/video/generations/{task_id}  查询 → {code:"success", data:{status, fail_reason, result_url, ...}}
// 提交经 new-api 后，上游轮询/取消/配额退款由 new-api task 框架内核承担；控制面只做
// 提交 + 对外轮询。adapter 在请求内完成轮询（worker 不做轮询，与 metaso/filmera 同架构约定）。
//
// 开关：NEWAPI_VIDEO_KERNEL=1（或 true）→ video 任务走本档；未设/0 → 现行 metaso 直调桥
//（分流在 supplier-adapter.ts 的 generateWithSupplier）。影子期两路并存，直调桥退役是 P2。
//
// 已知语义缺口（vs metaso 直调桥）：new-api hailuo task 适配器的 VideoRequest 无 ratio
// 栏位，aspect ratio 无法透传（成片取上游默认比例）；first/last frame 参考图靠
// TaskSubmitReq.metadata 透传，依赖部署版本支援 metadata passthrough（rc.21 需影子实测）。

const NEWAPI_REQUEST_TIMEOUT_MS = 30_000;
// 与 metaso 直调桥同节奏：5s 轮询、540s 上限（平台 600s 上限留余量）。env 可调（测试/调优用），
// 呼叫时读取（模组载入后仍可改 env，测试提速轮询用）。
function pollIntervalMs(): number {
  return Number(process.env.NEWAPI_VIDEO_POLL_INTERVAL_MS ?? 5_000);
}
function maxWaitMs(): number {
  return Number(process.env.NEWAPI_VIDEO_MAX_WAIT_MS ?? 540_000);
}
// 提交回应写出与 new-api tasks 落库之间存在毫秒级窗口（adaptor 先写 JSON 回应、后 task.Insert），
// 刚提交就查询可能短暂 task_not_exist；宽限期内视为未就绪，继续轮询。
const NEWAPI_TASK_GRACE_MS = 30_000;

// 与 metaso-upstream.ts 的 METASO_RESOLUTION 同映射：控制面 resolution → MiniMax 桥方言值。
// metadata.resolution 走 new-api hailuo 适配器的 UnmarshalMetadata 透传，覆盖 size 解析结果；
// size 同时给出（含 "720"/"1080" 字样）以兼容无 metadata passthrough 的部署版本。
const RESOLUTION_BY_INPUT: Record<string, string> = { "720p": "768P", "1080p": "2K" };
const SIZE_BY_INPUT: Record<string, string> = { "720p": "1280x720", "1080p": "1920x1080" };

export function isNewApiVideoKernelEnabled(): boolean {
  const value = (process.env.NEWAPI_VIDEO_KERNEL ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

function kernelBaseUrl(): string {
  const base = (process.env.NEWAPI_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new SupplierRequestError("NEWAPI_VIDEO_KERNEL is enabled but NEWAPI_BASE_URL is not configured.", 500);
  }
  return base;
}

function kernelApiKey(): string {
  const key = (process.env.NEWAPI_API_KEY ?? "").trim();
  if (!key) {
    throw new SupplierRequestError("NEWAPI_VIDEO_KERNEL is enabled but NEWAPI_API_KEY is not configured.", 500);
  }
  return key;
}

// new-api 查询回应的 data 是 tasks 表 DTO（dto.TaskDto）：status 为 Go TaskStatus 枚举
// NOT_START/SUBMITTED/QUEUED/IN_PROGRESS/FAILURE/SUCCESS/UNKNOWN。
interface NewApiTaskData {
  task_id?: unknown;
  status?: unknown;
  fail_reason?: unknown;
  result_url?: unknown;
  channel_id?: unknown;
  private_data?: unknown;
}

function readPrivateDataResultUrl(privateData: unknown): string | null {
  if (typeof privateData === "string") {
    try {
      privateData = JSON.parse(privateData);
    } catch {
      return null;
    }
  }
  if (typeof privateData !== "object" || privateData === null) return null;
  const url = (privateData as { result_url?: unknown }).result_url;
  return typeof url === "string" ? url : null;
}

function normalizeOutputUrl(value: unknown): string | null {
  const url = typeof value === "string" ? value.trim() : "";
  return url.startsWith("http://") || url.startsWith("https://") ? url : null;
}

function statusError(payload: Record<string, unknown>, httpStatus: number): SupplierRequestError {
  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message
      : typeof (payload.error as { message?: unknown } | undefined)?.message === "string"
        ? String((payload.error as { message?: unknown }).message)
        : `new-api video API request failed with HTTP ${httpStatus}.`;
  // status 照既有语义改写（供应商侧失败，隔离/冷却行为不动；请勿在此改判）；
  // upstreamStatus 原样带上上游真实状态，供确定性 4xx 的原生硬停判读
  // （D-3：真 400 不得被 502 洗成「可重放」而被重放 20 次）。
  const status = httpStatus === 429 ? 429 : httpStatus === 401 || httpStatus === 403 ? 401 : 502;
  return new SupplierRequestError(message, status, null, undefined, undefined, undefined, httpStatus);
}

async function newApiRequest(baseUrl: string, path: string, apiKey: string, init?: { body?: string; signal?: AbortSignal; idempotencyKey?: string }): Promise<{ payload: Record<string, unknown>; ok: boolean; status: number }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init?.body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(init?.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey, "X-Request-ID": init.idempotencyKey } : {}),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: init.body } : {}),
      signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(NEWAPI_REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("new-api video API request timed out.", 408);
    }
    throw new SupplierRequestError("new-api video submission transport outcome is unknown.", 408, null, undefined, "unknown");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SupplierRequestError(`new-api video API returned invalid JSON (HTTP ${response.status}).`, 502);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SupplierRequestError("new-api video API returned a non-object response.", 502);
  }
  // 非 2xx 不在此抛出：轮询层要能检视 payload.code（task_not_exist 落库宽限期判断需要原文）。
  return { payload: payload as Record<string, unknown>, ok: response.ok, status: response.status };
}

export async function generateWithNewApiVideo(input: SupplierGenerationInput): Promise<SupplierGenerationOutput> {  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 7_000) {
    throw new SupplierRequestError("Video prompt must contain 1–7000 characters.", 400);
  }
  const duration = Math.round(Number(input.workflow.durationSeconds ?? 5));
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new SupplierRequestError("Video duration must be an integer from 4 through 15 seconds.", 400);
  }
  const resolution = input.resolution ?? "";
  if (!(resolution in RESOLUTION_BY_INPUT)) {
    throw new SupplierRequestError(`new-api video kernel does not support resolution ${resolution || "(empty)"}.`, 400);
  }
  const references = input.workflow.references ?? [];
  if (references.length > 2) {
    throw new SupplierRequestError("Video first/last-frame mode accepts at most two images.", 400);
  }

  // 提交体按 new-api TaskSubmitReq（hailuo 适配器）形状构造：model 用控制面模型 id
  //（minimax-h3），渠道映射（channel 8 model_mapping → MiniMax-H3）与渠道选择由 new-api
  // Distribute 内核承担——内核路径不依赖 supplier 表。metadata 只装透传栏位，
  // 不整包转发 workflow.metadata（controlNets 等控制面私有键不得外泄）。
  const metadata: Record<string, unknown> = { resolution: RESOLUTION_BY_INPUT[resolution] };
  if (references[0]) metadata.first_frame_image = references[0].url;
  if (references[1]) metadata.last_frame_image = references[1].url;

  const baseUrl = kernelBaseUrl();
  const apiKey = kernelApiKey();
  const submit = await newApiRequest(baseUrl, "/video/generations", apiKey, {
    signal: input.signal, idempotencyKey: input.idempotencyKey ?? input.attemptId,
    body: JSON.stringify({
      model: input.modelId,
      prompt,
      duration,
      size: SIZE_BY_INPUT[resolution],
      metadata,
    }),
  });
  if (!submit.ok) throw statusError(submit.payload, submit.status);
  const submitPayload = submit.payload;
  const taskId = String(submitPayload.task_id ?? submitPayload.id ?? "").trim();
  if (!taskId) {
    throw new SupplierRequestError("new-api video submit response is missing task_id.", 502);
  }
  // INC-0831：上游任务已提交 → worker durably 落 attempt 行（task id + 对帐排程）。
  // 只发事件不落行 = 中控打掉上游成功任务的事故重演。
  await input.onProviderTaskSubmitted?.(taskId, "newapi_video");

  const submittedAt = Date.now();
  const deadline = submittedAt + maxWaitMs();
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    const { payload, ok, status: httpStatus } = await newApiRequest(baseUrl, `/video/generations/${encodeURIComponent(taskId)}`, apiKey);
    const code = typeof payload.code === "string" ? payload.code : "";
    // 查询回应包裹在 {code:"success", data:TaskDto}；非 success code 一律是错误
    //（含 HTTP 4xx 的 {code:"task_not_exist",...} 形状）。
    if (code !== "success") {
      // 落库窗口内的 task_not_exist 视为未就绪（见 NEWAPI_TASK_GRACE_MS 注释）。
      if (code === "task_not_exist" && Date.now() - submittedAt < NEWAPI_TASK_GRACE_MS) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs()));
        continue;
      }
      if (!ok) throw statusError(payload, httpStatus);
      const message = typeof payload.message === "string" ? payload.message : code || "unknown error";
      throw new SupplierRequestError(`new-api video task query failed: ${message}`, 502, undefined, undefined, undefined, taskId);
    }
    const data = payload.data as NewApiTaskData | null | undefined;
    if (typeof data !== "object" || data === null) {
      throw new SupplierRequestError("new-api video task query response is missing data.", 502, undefined, undefined, undefined, taskId);
    }
    const status = String(data.status ?? "").trim();

    if (status === "SUCCESS") {
      // 结果 URL 正规位置是 TaskDto.result_url（new-api 由 private_data.result_url 投影）；
      // 兼容旧部署直接回 private_data.result_url 的形状。
      const outputUrl = normalizeOutputUrl(data.result_url) ?? normalizeOutputUrl(readPrivateDataResultUrl(data.private_data));
      if (!outputUrl) {
        throw new SupplierRequestError("new-api succeeded video task is missing result_url.", 502, undefined, JSON.stringify(payload).slice(0, 2000), "upstream_protocol", taskId);
      }
      return {
        base64: null,
        url: outputUrl,
        providerTaskId: taskId,
        httpStatus: 200,
        endpointLabel: "new-api",
        supplierModelId: input.modelId,
        evidence: {
          adapter: "newapi_video_kernel",
          ...(typeof data.channel_id === "number" ? { newApiChannelId: data.channel_id } : {}),
        },
      };
    }

    if (status === "FAILURE") {
      const failReason = typeof data.fail_reason === "string" && data.fail_reason.trim() ? data.fail_reason.trim() : "unknown failure";
      // 上游错误原文透传（fail_reason 不改写），排障不用盲猜。
      throw new SupplierRequestError(`new-api video task failed: ${failReason}`, 502, undefined, undefined, undefined, taskId);
    }

    // SUCCESS/FAILURE 之外一律视为仍在跑（含 UNKNOWN——上游枚举扩张时保守继续轮询，
    // 由总时限兜底），与 new-api 更新器「未知上游状态 → IN_PROGRESS」的默认一致。
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs()));
  }

  // 无客户端取消路由（rc.21 视频路由面只有提交/查询）；超时后上游任务由 new-api 内核
  // 继续跑完并自行结算/退款。INC-0831：带上 task id 让对帐循环接手查真相，
  // 控制面不再单方面按超时宣判失败。
  throw new SupplierRequestError(`new-api video generation timed out after ${Math.round(maxWaitMs() / 1000)}s.`, 504, undefined, undefined, undefined, taskId);
}

/**
 * INC-0831 对帐轮询：按 provider task id 查上游真相（provider-reconciliation 用，
 * 只读不改任何任务状态）。响应形状解析与 generateWithNewApiVideo 同源。
 * 网络类错误抛出（调用端按退避重排）；上游确认的 SUCCESS/FAILURE 返回结构化真相。
 */
export async function pollNewApiVideoTask(providerTaskId: string): Promise<ProviderTaskPollResult> {
  const baseUrl = kernelBaseUrl();
  const apiKey = kernelApiKey();
  const { payload, ok, status: httpStatus } = await newApiRequest(baseUrl, `/video/generations/${encodeURIComponent(providerTaskId)}`, apiKey);
  const code = typeof payload.code === "string" ? payload.code : "";
  if (code !== "success") {
    // 对帐距提交已远（首轮 ≥60s），task_not_exist 视为上游不认得该任务——保守视为
    // 仍在跑等下轮，宁可冻结到窗口耗尽也不假宣判失败退款。
    if (code === "task_not_exist") return { state: "running" };
    if (ok) return { state: "running" };
    throw statusError(payload, httpStatus);
  }
  const data = payload.data as NewApiTaskData | null | undefined;
  if (typeof data !== "object" || data === null) return { state: "running" };
  const status = String(data.status ?? "").trim();
  if (status === "SUCCESS") {
    const outputUrl = normalizeOutputUrl(data.result_url) ?? normalizeOutputUrl(readPrivateDataResultUrl(data.private_data));
    return outputUrl
      ? { state: "succeeded", url: outputUrl, base64: null }
      : { state: "failed", reason: "new-api succeeded video task is missing result_url." };
  }
  if (status === "FAILURE") {
    const failReason = typeof data.fail_reason === "string" && data.fail_reason.trim() ? data.fail_reason.trim() : "unknown failure";
    return { state: "failed", reason: `new-api video task failed: ${failReason}` };
  }
  return { state: "running" };
}
