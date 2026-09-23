import { SupplierRequestError } from "./failure-classifier";
import type { ProviderTaskPollResult, SupplierGenerationInput, SupplierGenerationOutput } from "./types";

// new-api 原生視頻任務內核封裝（P1「任務語義歸一 new-api」核心刀，2026-08-28）。
//
// new-api v1.0.0-rc.21 原生異步視頻 relay（路由與回應形狀對照上游源碼實測，
// 見 surgery/newapi-kernel-intel.md；渠道 8 metaso-hailuo-bridge 已 relay 出真片）：
//   POST {base}/video/generations            提交 → OpenAI video 形狀 {id, task_id, ...}
//   GET  {base}/video/generations/{task_id}  查詢 → {code:"success", data:{status, fail_reason, result_url, ...}}
// 提交經 new-api 後，上游輪詢/取消/配額退款由 new-api task 框架內核承擔；控制面只做
// 提交 + 對外輪詢。adapter 在請求內完成輪詢（worker 不做輪詢，與 metaso/filmera 同架構約定）。
//
// 開關：NEWAPI_VIDEO_KERNEL=1（或 true）→ video 任務走本檔；未設/0 → 現行 metaso 直調橋
//（分流在 supplier-adapter.ts 的 generateWithSupplier）。影子期兩路並存，直調橋退役是 P2。
//
// 已知語義缺口（vs metaso 直調橋）：new-api hailuo task 適配器的 VideoRequest 無 ratio
// 欄位，aspect ratio 無法透傳（成片取上游默認比例）；first/last frame 參考圖靠
// TaskSubmitReq.metadata 透傳，依賴部署版本支援 metadata passthrough（rc.21 需影子實測）。

const NEWAPI_REQUEST_TIMEOUT_MS = 30_000;
// 與 metaso 直調橋同節奏：5s 輪詢、540s 上限（平台 600s 上限留餘量）。env 可調（測試/調優用），
// 呼叫時讀取（模組載入後仍可改 env，測試提速輪詢用）。
function pollIntervalMs(): number {
  return Number(process.env.NEWAPI_VIDEO_POLL_INTERVAL_MS ?? 5_000);
}
function maxWaitMs(): number {
  return Number(process.env.NEWAPI_VIDEO_MAX_WAIT_MS ?? 540_000);
}
// 提交回應寫出與 new-api tasks 落庫之間存在毫秒級窗口（adaptor 先寫 JSON 回應、後 task.Insert），
// 剛提交就查詢可能短暫 task_not_exist；寬限期內視為未就緒，繼續輪詢。
const NEWAPI_TASK_GRACE_MS = 30_000;

// 與 metaso-upstream.ts 的 METASO_RESOLUTION 同映射：控制面 resolution → MiniMax 橋方言值。
// metadata.resolution 走 new-api hailuo 適配器的 UnmarshalMetadata 透傳，覆蓋 size 解析結果；
// size 同時給出（含 "720"/"1080" 字樣）以兼容無 metadata passthrough 的部署版本。
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

// new-api 查詢回應的 data 是 tasks 表 DTO（dto.TaskDto）：status 為 Go TaskStatus 枚舉
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
  // status 照既有語義改寫（供應商側失敗，隔離/冷卻行為不動；請勿在此改判）；
  // upstreamStatus 原樣帶上上游真實狀態，供確定性 4xx 的原生硬停判讀
  // （D-3：真 400 不得被 502 洗成「可重放」而被重放 20 次）。
  const status = httpStatus === 429 ? 429 : httpStatus === 401 || httpStatus === 403 ? 401 : 502;
  return new SupplierRequestError(message, status, null, undefined, undefined, undefined, httpStatus);
}

async function newApiRequest(baseUrl: string, path: string, apiKey: string, init?: { body?: string }): Promise<{ payload: Record<string, unknown>; ok: boolean; status: number }> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: init?.body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(NEWAPI_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("new-api video API request timed out.", 408);
    }
    throw new SupplierRequestError("new-api video API request failed.", 502);
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
  // 非 2xx 不在此拋出：輪詢層要能檢視 payload.code（task_not_exist 落庫寬限期判斷需要原文）。
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

  // 提交體按 new-api TaskSubmitReq（hailuo 適配器）形狀構造：model 用控制面模型 id
  //（minimax-h3），渠道映射（channel 8 model_mapping → MiniMax-H3）與渠道選擇由 new-api
  // Distribute 內核承擔——內核路徑不依賴 supplier 表。metadata 只裝透傳欄位，
  // 不整包轉發 workflow.metadata（controlNets 等控制面私有鍵不得外洩）。
  const metadata: Record<string, unknown> = { resolution: RESOLUTION_BY_INPUT[resolution] };
  if (references[0]) metadata.first_frame_image = references[0].url;
  if (references[1]) metadata.last_frame_image = references[1].url;

  const baseUrl = kernelBaseUrl();
  const apiKey = kernelApiKey();
  const submit = await newApiRequest(baseUrl, "/video/generations", apiKey, {
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
  // INC-0831：上游任務已提交 → worker durably 落 attempt 行（task id + 對帳排程）。
  // 只發事件不落行 = 中控打掉上游成功任務的事故重演。
  input.onProviderTaskSubmitted?.(taskId, "newapi_video");

  const submittedAt = Date.now();
  const deadline = submittedAt + maxWaitMs();
  while (Date.now() < deadline) {
    const { payload, ok, status: httpStatus } = await newApiRequest(baseUrl, `/video/generations/${encodeURIComponent(taskId)}`, apiKey);
    const code = typeof payload.code === "string" ? payload.code : "";
    // 查詢回應包裹在 {code:"success", data:TaskDto}；非 success code 一律是錯誤
    //（含 HTTP 4xx 的 {code:"task_not_exist",...} 形狀）。
    if (code !== "success") {
      // 落庫窗口內的 task_not_exist 視為未就緒（見 NEWAPI_TASK_GRACE_MS 註釋）。
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
      // 結果 URL 正規位置是 TaskDto.result_url（new-api 由 private_data.result_url 投影）；
      // 兼容舊部署直接回 private_data.result_url 的形狀。
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
      // 上游錯誤原文透傳（fail_reason 不改寫），排障不用盲猜。
      throw new SupplierRequestError(`new-api video task failed: ${failReason}`, 502, undefined, undefined, undefined, taskId);
    }

    // SUCCESS/FAILURE 之外一律視為仍在跑（含 UNKNOWN——上游枚舉擴張時保守繼續輪詢，
    // 由總時限兜底），與 new-api 更新器「未知上游狀態 → IN_PROGRESS」的默認一致。
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs()));
  }

  // 無客戶端取消路由（rc.21 視頻路由面只有提交/查詢）；超時後上游任務由 new-api 內核
  // 繼續跑完並自行結算/退款。INC-0831：帶上 task id 讓對帳循環接手查真相，
  // 控制面不再單方面按超時宣判失敗。
  throw new SupplierRequestError(`new-api video generation timed out after ${Math.round(maxWaitMs() / 1000)}s.`, 504, undefined, undefined, undefined, taskId);
}

/**
 * INC-0831 對帳輪詢：按 provider task id 查上游真相（provider-reconciliation 用，
 * 只讀不改任何任務狀態）。響應形狀解析與 generateWithNewApiVideo 同源。
 * 網絡類錯誤拋出（調用端按退避重排）；上游確認的 SUCCESS/FAILURE 返回結構化真相。
 */
export async function pollNewApiVideoTask(providerTaskId: string): Promise<ProviderTaskPollResult> {
  const baseUrl = kernelBaseUrl();
  const apiKey = kernelApiKey();
  const { payload, ok, status: httpStatus } = await newApiRequest(baseUrl, `/video/generations/${encodeURIComponent(providerTaskId)}`, apiKey);
  const code = typeof payload.code === "string" ? payload.code : "";
  if (code !== "success") {
    // 對帳距提交已遠（首輪 ≥60s），task_not_exist 視為上游不認得該任務——保守視為
    // 仍在跑等下輪，寧可凍結到窗口耗盡也不假宣判失敗退款。
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
