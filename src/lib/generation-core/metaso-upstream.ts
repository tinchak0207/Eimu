import { MINIMAX_H3_MODEL_ID } from "../image-model-ids.js";
import { SupplierRequestError } from "./failure-classifier";
import type { ProviderTaskPollResult, SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// metaso.cn MiniMax-H3 文生视频上游封装（2026-08-27 实测打通）。
//
// 协议非 OpenAI 兼容（自定路径 + 异步任务）：
//   POST {base}/v2/video_generation           建任务 → {task_id}
//   GET  {base}/v2/query/video_generation/{id} 轮询 → {task:{status, content:{url}}}
//   DELETE {base}/v2/video_generation/{id}    取消排队中任务（超时兜底，best effort）
// adapter 在请求内完成轮询（worker 不做轮询，与 filmera 同架构约定）。

const METASO_API_MODEL = "MiniMax-H3";
const METASO_POLL_INTERVAL_MS = 5_000;
// 平台 video 上游超时 600s；轮询上限压到 540s 留出 create/查询余量。
const METASO_MAX_WAIT_MS = 540_000;
const METASO_REQUEST_TIMEOUT_MS = 30_000;
const METASO_ALLOWED_RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

const METASO_RESOLUTION: Record<string, string> = { "720p": "768P", "1080p": "2K" };

interface MetasoTask {
  status?: unknown;
  content?: { url?: unknown } | null;
  error?: { code?: unknown; message?: unknown } | null;
  resolution?: unknown;
  duration?: unknown;
  ratio?: unknown;
  modality?: unknown;
}

export function isMetasoModel(modelId: string): boolean {
  return modelId === MINIMAX_H3_MODEL_ID;
}

export async function generateWithMetaso(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
): Promise<SupplierGenerationOutput> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 7_000) {
    throw new SupplierRequestError("Metaso prompt must contain 1–7000 characters.", 400);
  }
  const duration = Math.round(Number(input.workflow.durationSeconds ?? 5));
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new SupplierRequestError("Metaso duration must be an integer from 4 through 15 seconds.", 400);
  }
  const resolution = METASO_RESOLUTION[input.resolution ?? ""] ?? "768P";
  const ratio = input.ratio ?? "16:9";
  if (!METASO_ALLOWED_RATIOS.has(ratio)) {
    throw new SupplierRequestError(`Metaso does not support aspect ratio ${ratio}.`, 400);
  }
  const references = input.workflow.references ?? [];
  if (references.length > 2) {
    throw new SupplierRequestError("Metaso first/last-frame mode accepts at most two images.", 400);
  }

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (references[0]) {
    content.push({ type: "image_url", image_url: { url: references[0].url }, role: "first_frame" });
  }
  if (references[1]) {
    content.push({ type: "image_url", image_url: { url: references[1].url }, role: "last_frame" });
  }

  const apiKey = readMetasoCredential(supplier);
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "");
  const createResponse = await metasoRequest(baseUrl, "v2/video_generation", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      model: METASO_API_MODEL,
      content,
      resolution,
      duration,
      ratio: references.length > 0 ? "adaptive" : ratio,
    }),
  });
  const taskId = String(createResponse.task_id ?? "");
  if (!taskId.trim()) {
    throw new SupplierRequestError("Metaso create response is missing task_id.", 502);
  }
  // INC-0831：上游任务已提交 → worker durably 落 attempt 行（task id + 对帐排程）。
  input.onProviderTaskSubmitted?.(taskId.trim(), "metaso");

  const deadline = Date.now() + METASO_MAX_WAIT_MS;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    const response = await metasoRequest(baseUrl, `v2/query/video_generation/${encodeURIComponent(taskId)}`, {
      method: "GET",
      apiKey,
    });
    if (!response.task || typeof response.task !== "object" || Array.isArray(response.task)) {
      throw new SupplierRequestError("Metaso query response is missing task.", 502);
    }
    const task = response.task as MetasoTask;
    const status = String(task.status ?? "").trim();
    lastStatus = status;

    if (status === "succeeded") {
      if (task.modality != null && task.modality !== "video") {
        throw new SupplierRequestError("Metaso returned a non-video result for video generation.", 502);
      }
      const outputUrl = String(task.content?.url ?? "").trim();
      if (!outputUrl.startsWith("http://") && !outputUrl.startsWith("https://")) {
        throw new SupplierRequestError("Metaso succeeded response is missing content.url.", 502);
      }
      return {
        base64: null,
        url: outputUrl,
        providerTaskId: taskId,
        httpStatus: 200,
        endpointLabel: supplier.label,
        supplierModelId: MINIMAX_H3_MODEL_ID,
      };
    }

    if (status === "failed") {
      const code = typeof task.error?.code === "string" ? task.error.code : "task_failed";
      const detail = typeof task.error?.message === "string" ? task.error.message : "Metaso video generation failed";
      throw new SupplierRequestError(`Metaso task failed (${code}): ${detail}`, 502);
    }
    if (status === "cancelled") {
      throw new SupplierRequestError("Metaso video generation was cancelled.", 502);
    }
    if (status !== "queued" && status !== "running") {
      throw new SupplierRequestError(`Metaso returned an unknown task status: ${status}`, 502);
    }
    await new Promise((resolve) => setTimeout(resolve, METASO_POLL_INTERVAL_MS));
  }

  if (lastStatus === "queued") {
    try {
      await metasoRequest(baseUrl, `v2/video_generation/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        apiKey,
      });
    } catch {
      // Best effort only: the task may have started between the last poll and timeout.
    }
  }
  // INC-0831：超时不再单方面宣判失败——带上 task id 让对帐循环接手查上游真相
  //（上游任务在轮询窗口外照样会跑完）。
  throw new SupplierRequestError(`Metaso video generation timed out after ${Math.round(METASO_MAX_WAIT_MS / 1000)}s.`, 504, undefined, undefined, undefined, taskId);
}

function readMetasoCredential(supplier: SupplierRecord): string {
  const value = process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef] ?? "";
  if (!value.trim()) {
    throw new SupplierRequestError(`Missing configured credential ${supplier.account.credentialRef}.`, 401);
  }
  return value.trim();
}

async function metasoRequest(
  baseUrl: string,
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; apiKey: string; body?: string },
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
      signal: AbortSignal.timeout(METASO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("Metaso request timed out.", 408);
    }
    throw new SupplierRequestError("Metaso request failed.", 502);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // 同一类状态洗白（D-3）：上游回 HTML 错误页（常见于 400/5xx）时，真实状态不能丢，
    // 否则真 400 会以 502 进原生硬停判定。产品侧 status 仍是 502（我方解析失败）。
    throw new SupplierRequestError(
      `Metaso returned invalid JSON (HTTP ${response.status}).`,
      502,
      null,
      undefined,
      undefined,
      undefined,
      response.status,
    );
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: { message?: unknown } }).error?.message ?? payload)
        : `Metaso API request failed with HTTP ${response.status}.`;
    // status 照既有语义改写（供应商侧失败，隔离/冷却行为不动；请勿在此改判）；
    // upstreamStatus 原样带上上游真实状态，供确定性 4xx 的原生硬停判读
    // （D-3：真 400 不得被 502 洗成「可重放」而被重放 20 次）。
    throw new SupplierRequestError(
      message,
      response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 401 : 502,
      null,
      undefined,
      undefined,
      undefined,
      response.status,
    );
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SupplierRequestError("Metaso returned a non-object response.", 502);
  }
  return payload as Record<string, unknown>;
}

/**
 * INC-0831 对帐轮询：按 task id 查 metaso 任务真相（provider-reconciliation 用，
 * 只读不改任何任务状态）。响应解析与 generateWithMetaso 同源；查无 task 行时
 * 保守视为仍在跑（宁可冻结到对帐窗口耗尽，不假宣判失败退款）。
 */
export async function pollMetasoTask(
  supplier: SupplierRecord,
  providerTaskId: string,
): Promise<ProviderTaskPollResult> {
  const apiKey = readMetasoCredential(supplier);
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "");
  const response = await metasoRequest(baseUrl, `v2/query/video_generation/${encodeURIComponent(providerTaskId)}`, {
    method: "GET",
    apiKey,
  });
  if (!response.task || typeof response.task !== "object" || Array.isArray(response.task)) {
    return { state: "running" };
  }
  const task = response.task as MetasoTask;
  const status = String(task.status ?? "").trim();
  if (status === "succeeded") {
    const outputUrl = String(task.content?.url ?? "").trim();
    if (!outputUrl.startsWith("http://") && !outputUrl.startsWith("https://")) {
      return { state: "failed", reason: "Metaso succeeded response is missing content.url." };
    }
    return { state: "succeeded", url: outputUrl, base64: null };
  }
  if (status === "failed") {
    const code = typeof task.error?.code === "string" ? task.error.code : "task_failed";
    const detail = typeof task.error?.message === "string" ? task.error.message : "Metaso video generation failed";
    return { state: "failed", reason: `Metaso task failed (${code}): ${detail}` };
  }
  if (status === "cancelled") {
    return { state: "failed", reason: "Metaso video generation was cancelled." };
  }
  return { state: "running" };
}
