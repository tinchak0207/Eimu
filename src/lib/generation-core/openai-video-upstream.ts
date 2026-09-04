import { SupplierRequestError } from "./failure-classifier";
import type { ProviderTaskPollResult, SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// cangyuansuanli（new-api openai-video 兼容）seedance 视频上游封装（2026-08-30）。
//
// 协议（与 metaso/filmera 同架构约定，adapter 在请求内完成轮询）：
//   POST {base}/videos                    提交 → {id, status:"queued"}
//   GET  {base}/videos/{task_id}          轮询 → 三族响应（2026-08-30 实弹校准）：
//     sd4:  {status:"completed", video_url, metadata:{url}}（顶层 video_url 与
//           metadata.url 同值；无 data 数组。实弹 task_… 响应实锤）
//     sd7:  {status:"completed", metadata:{video_url}}
//     sd10: {status:"succeeded", data:[{url:"/v1/videos/{id}/file"}]}（暂不接入）
//
// 模型名由 adapter 按平台 modelId + resolution 解析（上游 sd4 族分辨率可选、
// sd7 族固定分辨率由模型名决定），不依赖 supplier 表 supplierModelId。

const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 540_000;
const REQUEST_TIMEOUT_MS = 30_000;

// 平台模型 id + resolution → 上游模型名映射
// sd4 族：分辨率可选（480p/720p），请求带 resolution 字段
// sd7 族：模型名固定分辨率，请求不带 resolution 字段
const UPSTREAM_MODEL_BY_RESOLUTION: Record<string, Record<string, string>> = {
  "seedance-2.0": {
    "480p": "sd4-seedance-2.0",
    "720p": "sd4-seedance-2.0",
    "1080p": "sd7-seedance-2.0-1080p",
  },
  "seedance-2.0-fast": {
    "480p": "sd4-seedance-2.0-fast",
    "720p": "sd4-seedance-2.0-fast",
  },
  "seedance-2.0-mini": {
    "480p": "sd4-seedance-2.0-mini",
    "720p": "sd4-seedance-2.0-mini",
  },
  "seedance-2.5-480p": {
    "480p": "sd4-seedance-2.5-480p",
  },
  "seedance-2.5-720p": {
    "720p": "sd4-seedance-2.5-720p",
  },
  // drama 渠道（drama.dafeiyangapi.top）专属 30 秒固定档（2026-08-30 接入）：
  // 上游只有 sd25-30s 一个模型，30s/720p 固定，按条计费。
  "seedance-2.5-30s": {
    "720p": "sd25-30s",
  },
};

// sd7 族模型名集合：固定清晰度，请求体不含 resolution 字段
const SD7_MODEL_NAMES = new Set([
  "sd7-seedance-2.0-1080p",
  "sd7-seedance-2.0-720p",
]);

// drama sd25-30s 族：30 秒固定档（必带 seconds:30、禁止 generate_audio、
// 完成后无公网 URL 时走 /videos/{id}/content 鉴权下载）
const DRAMA_30S_MODEL_NAMES = new Set(["sd25-30s"]);

// 每个平台模型允许的 duration 范围（秒）
const DURATION_RANGES: Record<string, [number, number]> = {
  "seedance-2.0":      [4, 15],
  "seedance-2.0-fast": [4, 15],
  "seedance-2.0-mini": [4, 15],
  "seedance-2.5-480p": [4, 30],
  "seedance-2.5-720p": [4, 29],
  "seedance-2.5-30s":  [30, 30],
};

function resolveUpstreamModel(platformModelId: string, resolution: string): string {
  const byResolution = UPSTREAM_MODEL_BY_RESOLUTION[platformModelId];
  if (!byResolution) {
    throw new SupplierRequestError(`openai-video upstream: unknown platform model "${platformModelId}".`, 400);
  }
  const upstreamModel = byResolution[resolution];
  if (!upstreamModel) {
    throw new SupplierRequestError(
      `openai-video upstream: platform model "${platformModelId}" has no mapping for resolution "${resolution}".`,
      400,
    );
  }
  return upstreamModel;
}

export async function generateWithOpenaiVideo(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
): Promise<SupplierGenerationOutput> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 5_000) {
    throw new SupplierRequestError("Video prompt must contain 1–5000 characters.", 400);
  }

  const platformModelId = input.modelId;
  const resolution = input.resolution ?? "";
  const duration = Math.round(Number(input.workflow.durationSeconds ?? 5));
  const ratio = input.ratio ?? "16:9";

  // 校验 duration 范围
  const range = DURATION_RANGES[platformModelId];
  if (!range) {
    throw new SupplierRequestError(`openai-video upstream: unknown model "${platformModelId}" has no duration range configured.`, 400);
  }
  if (!Number.isInteger(duration) || duration < range[0] || duration > range[1]) {
    throw new SupplierRequestError(
      `openai-video upstream: "${platformModelId}" duration must be an integer from ${range[0]} through ${range[1]} seconds.`,
      400,
    );
  }

  const upstreamModel = resolveUpstreamModel(platformModelId, resolution);
  const isSd7 = SD7_MODEL_NAMES.has(upstreamModel);
  const isDrama30s = DRAMA_30S_MODEL_NAMES.has(upstreamModel);

  // 构建请求体
  const body: Record<string, unknown> = {
    model: upstreamModel,
    prompt,
    aspect_ratio: ratio,
    duration,
  };

  if (isDrama30s) {
    // drama sd25-30s 协议（官方 docs/drama，2026-08-30）：
    // seconds 必填整数 30（duration 兼容字段，同提交必须一致）；分辨率只认 720p；
    // 禁止 generate_audio（上游校验直接报错）；参考素材走 reference_image_urls 兼容字段。
    body.seconds = 30;
    body.resolution = "720p";
  } else if (!isSd7) {
    // sd4 族：透传 resolution + generate_audio
    body.resolution = resolution;
    body.generate_audio = input.workflow.generateAudio === true;
  } else {
    // sd7 族：固定清晰度、也支持音频
    body.generate_audio = input.workflow.generateAudio === true;
  }

  // 参考图（多模态参考）
  const references = input.workflow.references ?? [];
  if (references.length > 0) {
    if (isDrama30s && references.length > 30) {
      throw new SupplierRequestError("drama sd25-30s accepts at most 30 reference images.", 400);
    }
    if (isSd7 && references.length > 5) {
      throw new SupplierRequestError("sd7 family accepts at most 5 reference images.", 400);
    }
    if (!isSd7 && !isDrama30s && references.length > 4) {
      throw new SupplierRequestError("sd4 family accepts at most 4 reference images.", 400);
    }
    body.reference_image_urls = references.map((ref) => ref.url);
  }

  const apiKey = readOpenaiVideoCredential(supplier);
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "");

  // 提交任务
  const createResponse = await openaiVideoRequest(baseUrl, "videos", {
    method: "POST",
    apiKey,
    body: JSON.stringify(body),
  });
  const taskId = String(createResponse.id ?? "").trim();
  if (!taskId) {
    throw new SupplierRequestError("openai-video upstream create response is missing id.", 502);
  }
  const modelInResponse = String(createResponse.model ?? "").trim();
  // 上游任务已提交：通知 worker durably 落 attempt 行（task id + 对账排程，INC-0831）
  input.onProviderTaskSubmitted?.(taskId, "openai_video");

  // 轮询
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    const queryResponse = await openaiVideoRequest(baseUrl, `videos/${encodeURIComponent(taskId)}`, {
      method: "GET",
      apiKey,
    });
    const status = String(queryResponse.status ?? "").trim();
    lastStatus = status;

    // 完成态：sd4/sd7 用 "completed"，sd10 用 "succeeded"（暂不接入）
    if (status === "completed" || status === "succeeded") {
      const outputUrl = extractOutputUrl(queryResponse, baseUrl, taskId);
      if (outputUrl) {
        return {
          base64: null,
          url: outputUrl,
          providerTaskId: taskId,
          providerRequestId: taskId,
          httpStatus: 200,
          endpointLabel: supplier.label,
          supplierModelId: upstreamModel,
          evidence: { adapter: "openai_video", supplierId: supplier.id, failureDomain: supplier.failureDomain },
        };
      }
      // drama sd25-30s：官方文档查询响应不保证携带成品 URL，下载统一走
      // /videos/{id}/content 且需 Bearer 鉴权——artifact 下载是裸 fetch，无法带
      // 鉴权头，所以必须在这里下载成 base64 交给 persistOutputArtifact。
      if (isDrama30s) {
        const base64 = await downloadDramaContent(baseUrl, taskId, apiKey);
        return {
          base64,
          url: null,
          providerTaskId: taskId,
          providerRequestId: taskId,
          httpStatus: 200,
          endpointLabel: supplier.label,
          supplierModelId: upstreamModel,
          evidence: { adapter: "openai_video", supplierId: supplier.id, failureDomain: supplier.failureDomain },
        };
      }
      // INC-0830-VIDEO：上游任务已成功（已扣费），解析不出 URL 是我们的协议
      // 解析 bug，不是上游过载。显式裁定 upstream_protocol，禁止熔断渠道。
      throw new SupplierRequestError(
        `openai-video upstream task ${taskId} completed but no output URL found in response.`,
        502,
        undefined,
        JSON.stringify(queryResponse).slice(0, 2000),
        "upstream_protocol",
        taskId,
      );
    }

    if (status === "failed") {
      const errorMsg = extractErrorMessage(queryResponse);
      throw new SupplierRequestError(`openai-video upstream task ${taskId} failed: ${errorMsg}`, 502, undefined, undefined, undefined, taskId);
    }
    if (status === "cancelled") {
      throw new SupplierRequestError(`openai-video upstream task ${taskId} was cancelled.`, 502, undefined, undefined, undefined, taskId);
    }

    // 未知状态或仍在排队/处理中
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new SupplierRequestError(
    `openai-video upstream generation timed out after ${Math.round(MAX_WAIT_MS / 1000)}s (last status: ${lastStatus ?? "none"}).`,
    504,
    undefined,
    undefined,
    undefined,
    taskId,
  );
}

/**
 * 从查询响应中提取输出视频 URL。
 *
 * 读取顺序（2026-08-30 实弹校准，sd4 真实形状顶层就有 video_url）：
 *   1. 顶层 video_url            （sd4 实锤：{video_url, metadata:{url}}）
 *   2. metadata.url              （sd4 冗余字段，同值）
 *   3. metadata.video_url        （sd7 族）
 *   4. data[0].url               （sd10 族相对路径 → 拼 baseUrl；http(s) 直用）
 */
function extractOutputUrl(response: Record<string, unknown>, baseUrl: string, taskId: string): string | null {
  // 顶层 video_url（sd4 族实锤形状）
  const topLevelUrl = String(response.video_url ?? "").trim();
  if (topLevelUrl.startsWith("http://") || topLevelUrl.startsWith("https://")) {
    return topLevelUrl;
  }

  const metadata = response.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    // sd4 族冗余：metadata.url；sd7 族：metadata.video_url
    for (const key of ["url", "video_url"] as const) {
      const videoUrl = String(metadata[key] ?? "").trim();
      if (videoUrl.startsWith("http://") || videoUrl.startsWith("https://")) {
        return videoUrl;
      }
    }
  }

  // sd10 族：data[0].url
  const data = response.data as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(data) && data.length > 0) {
    const url = String(data[0].url ?? "").trim();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    // 相对路径（sd10 族：/v1/videos/{id}/file）→ 拼接 base
    if (url.startsWith("/")) {
      return `${baseUrl}${url}`;
    }
  }

  return null;
}

// drama sd25-30s 成品下载：/videos/{id}/content 需 Bearer 鉴权（官方 docs 第 7 节），
// 只允许 completed 后调用。视频最大 ~512MB 上游侧、我们 25MiB 持久化上限兜底由
// persistOutputArtifact 复检；这里只要求 200 + 非空字节。
async function downloadDramaContent(baseUrl: string, taskId: string, apiKey: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/videos/${encodeURIComponent(taskId)}/content`, {
      method: "GET",
      headers: { Accept: "video/mp4", Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError(`openai-video upstream content download timed out (task ${taskId}).`, 504, undefined, undefined, "upstream_protocol", taskId);
    }
    throw new SupplierRequestError(`openai-video upstream content download failed (task ${taskId}).`, 502, undefined, undefined, "upstream_protocol", taskId);
  }
  if (!response.ok) {
    throw new SupplierRequestError(
      `openai-video upstream content download returned HTTP ${response.status} (task ${taskId}).`,
      502,
      undefined,
      undefined,
      "upstream_protocol",
      taskId,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) {
    throw new SupplierRequestError(`openai-video upstream content download returned empty body (task ${taskId}).`, 502, undefined, undefined, "upstream_protocol", taskId);
  }
  return bytes.toString("base64");
}

function extractErrorMessage(response: Record<string, unknown>): string {  if (typeof response.error_message === "string" && response.error_message.trim()) {
    return response.error_message.trim();
  }
  if (typeof response.error === "object" && response.error !== null) {
    const err = response.error as Record<string, unknown>;
    if (typeof err.message === "string" && err.message.trim()) {
      return err.message.trim();
    }
  }
  if (typeof response.message === "string" && response.message.trim()) {
    return response.message.trim();
  }
  return "unknown error";
}

function readOpenaiVideoCredential(supplier: SupplierRecord): string {
  const value = process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef] ?? "";
  if (!value.trim()) {
    throw new SupplierRequestError(`Missing configured credential ${supplier.account.credentialRef}.`, 401);
  }
  return value.trim();
}

async function openaiVideoRequest(
  baseUrl: string,
  path: string,
  init: { method: "GET" | "POST"; apiKey: string; body?: string },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${init.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("openai-video upstream request timed out.", 408);
    }
    throw new SupplierRequestError("openai-video upstream request failed.", 502);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SupplierRequestError(`openai-video upstream returned invalid JSON (HTTP ${response.status}).`, 502);
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null
        ? extractErrorMessage(payload as Record<string, unknown>)
        : `openai-video upstream API request failed with HTTP ${response.status}.`;
    throw new SupplierRequestError(
      message,
      response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SupplierRequestError("openai-video upstream returned a non-object response.", 502);
  }
  return payload as Record<string, unknown>;
}
/**
 * INC-0831 對帳輪詢：按 task id 查 openai-video 上游真相（provider-reconciliation
 * 用，只讀不改任何任務狀態）。響應解析與 generateWithOpenaiVideo 同源
 *（extractOutputUrl / downloadDramaContent 直接復用）。
 */
export async function pollOpenaiVideoTask(
  supplier: SupplierRecord,
  providerTaskId: string,
): Promise<ProviderTaskPollResult> {
  const apiKey = readOpenaiVideoCredential(supplier);
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "");
  const queryResponse = await openaiVideoRequest(baseUrl, `videos/${encodeURIComponent(providerTaskId)}`, {
    method: "GET",
    apiKey,
  });
  const status = String(queryResponse.status ?? "").trim();
  if (status === "completed" || status === "succeeded") {
    const outputUrl = extractOutputUrl(queryResponse, baseUrl, providerTaskId);
    if (outputUrl) return { state: "succeeded", url: outputUrl, base64: null };
    // completed 但無公網 URL（drama sd25-30s 形狀）：走 /videos/{id}/content 鑑欄下載。
    const base64 = await downloadDramaContent(baseUrl, providerTaskId, apiKey);
    return { state: "succeeded", url: null, base64 };
  }
  if (status === "failed") {
    return { state: "failed", reason: `openai-video upstream task failed: ${extractErrorMessage(queryResponse)}` };
  }
  if (status === "cancelled") {
    return { state: "failed", reason: `openai-video upstream task ${providerTaskId} was cancelled.` };
  }
  return { state: "running" };
}
