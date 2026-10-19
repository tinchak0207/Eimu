import { SupplierRequestError } from "./failure-classifier";
import type { ProviderTaskPollResult, SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// dmc.cc MiniMax-H3 文生视频上游封装（2026-10-13 两笔 5s 实弹打通）。
// 2026-10-18 上游改址 api.ll2.cn：协议路径不变，但 base 取**根路径**
// （https://api.ll2.cn，任务接口在 /v2/…；/v1 只是 OpenAI 兼容面）。
//
// 协议与 metaso 同形（MiniMax 官方形态）：
//   POST {base}/v2/video_generation           建任务 → {task_id}
//   GET  {base}/v2/query/video_generation/{id} 轮询 → {task:{status, content:{url}}}
//   DELETE {v2/video_generation/{id}          取消排队中任务（超时兜底，best effort）
// adapter 在请求内完成轮询（worker 不做轮询，与 filmera/metaso 同架构约定）。
//
// 轮子真源＝metaso-upstream.ts（逐行等价，白名单外零改动）；差异仅三项：
//   ① 上游模型名与错误文案用 dmc；
//   ② 分辨率：dmc 只出 768P（无 2K）⇒ 只认 720p→768P，其余档位明确拒收；
//   ③ 参考图：dmc 文档允许最多 9 张参考图。≤2 张沿用 metaso 的首/尾帧位契约
//      （「上游按位置解读」，见 blender-to-video-bridge.ts:6-11）；≥3 张因
//      first_frame/last_frame 不得与 reference_* 混用（dmc 文档 §5），整批改走
//      reference_image（保序）。

const DMC_API_MODEL = "MiniMax-H3";
const DMC_POLL_INTERVAL_MS = 5_000;
// 平台 video 上游超时 600s；轮询上限压到 540s 留出 create/查询余量。
const DMC_MAX_WAIT_MS = 540_000;
const DMC_REQUEST_TIMEOUT_MS = 30_000;
const DMC_ALLOWED_RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const DMC_MAX_REFERENCE_IMAGES = 9;
// dmc 只提供 768P 画布；平台 minimax-h3 catalog 的 720p 档即映射到此。
const DMC_RESOLUTION: Record<string, string> = { "720p": "768P", "768p": "768P", "768P": "768P" };

interface DmcTask {
  status?: unknown;
  content?: { url?: unknown } | null;
  error?: { code?: unknown; message?: unknown } | null;
  resolution?: unknown;
  duration?: unknown;
  ratio?: unknown;
  modality?: unknown;
}

export async function generateWithDmc(
  supplier: SupplierRecord,
  input: SupplierGenerationInput,
): Promise<SupplierGenerationOutput> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 7_000) {
    throw new SupplierRequestError("DMC prompt must contain 1–7000 characters.", 400);
  }
  const duration = Math.round(Number(input.workflow.durationSeconds ?? 5));
  if (!Number.isInteger(duration) || duration < 5 || duration > 15) {
    throw new SupplierRequestError("DMC duration must be an integer from 5 through 15 seconds.", 400);
  }
  const resolution = DMC_RESOLUTION[input.resolution ?? ""] ?? DMC_RESOLUTION["720p"];
  if (input.resolution && !DMC_RESOLUTION[input.resolution]) {
    throw new SupplierRequestError(`DMC MiniMax-H3 only outputs 768P; unsupported resolution ${input.resolution}.`, 400);
  }
  const ratio = input.ratio ?? "16:9";
  if (!DMC_ALLOWED_RATIOS.has(ratio)) {
    throw new SupplierRequestError(`DMC does not support aspect ratio ${ratio}.`, 400);
  }
  const references = input.workflow.references ?? [];
  if (references.length > DMC_MAX_REFERENCE_IMAGES) {
    throw new SupplierRequestError(`DMC accepts at most ${DMC_MAX_REFERENCE_IMAGES} reference images.`, 400);
  }

  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (references.length <= 2) {
    // 首/尾帧位（≤2）：与 metaso 相同的位置契约。
    if (references[0]) {
      content.push({ type: "image_url", image_url: { url: references[0].url }, role: "first_frame" });
    }
    if (references[1]) {
      content.push({ type: "image_url", image_url: { url: references[1].url }, role: "last_frame" });
    }
  } else {
    // ≥3 张：整批 reference_image（首/尾帧角色不得与 reference_* 混用）。
    for (const reference of references) {
      content.push({ type: "image_url", image_url: { url: reference.url }, role: "reference_image" });
    }
  }

  const apiKey = readDmcCredential(supplier);
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "");
  const createResponse = await dmcRequest(baseUrl, "v2/video_generation", {
    method: "POST",
    apiKey,
    signal: input.signal,
    idempotencyKey: input.idempotencyKey ?? input.attemptId,
    body: JSON.stringify({
      model: DMC_API_MODEL,
      content,
      resolution,
      duration,
      ratio: references.length > 0 ? "adaptive" : ratio,
    }),
  });
  const taskId = String(createResponse.task_id ?? "");
  if (!taskId.trim()) {
    throw new SupplierRequestError("DMC create response is missing task_id.", 502);
  }
  // INC-0831：上游任务已提交 → worker durably 落 attempt 行（task id + 对帐排程）。
  await input.onProviderTaskSubmitted?.(taskId.trim(), "dmc");

  const deadline = Date.now() + DMC_MAX_WAIT_MS;
  let lastStatus: string | undefined;
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    const response = await dmcRequest(baseUrl, `v2/query/video_generation/${encodeURIComponent(taskId)}`, {
      method: "GET",
      apiKey,
    });
    if (!response.task || typeof response.task !== "object" || Array.isArray(response.task)) {
      throw new SupplierRequestError("DMC query response is missing task.", 502);
    }
    const task = response.task as DmcTask;
    const status = String(task.status ?? "").trim();
    lastStatus = status;

    if (status === "succeeded") {
      if (task.modality != null && task.modality !== "video") {
        throw new SupplierRequestError("DMC returned a non-video result for video generation.", 502);
      }
      const outputUrl = String(task.content?.url ?? "").trim();
      if (!outputUrl.startsWith("http://") && !outputUrl.startsWith("https://")) {
        throw new SupplierRequestError("DMC succeeded response is missing content.url.", 502);
      }
      return {
        base64: null,
        url: outputUrl,
        providerTaskId: taskId,
        httpStatus: 200,
        endpointLabel: supplier.label,
        supplierModelId: DMC_API_MODEL,
      };
    }

    if (status === "failed") {
      const code = typeof task.error?.code === "string" ? task.error.code : "task_failed";
      const detail = typeof task.error?.message === "string" ? task.error.message : "DMC video generation failed";
      throw new SupplierRequestError(`DMC task failed (${code}): ${detail}`, 502);
    }
    if (status === "cancelled") {
      throw new SupplierRequestError("DMC video generation was cancelled.", 502);
    }
    if (status !== "queued" && status !== "running") {
      throw new SupplierRequestError(`DMC returned an unknown task status: ${status}`, 502);
    }
    await new Promise((resolve) => setTimeout(resolve, DMC_POLL_INTERVAL_MS));
  }

  if (lastStatus === "queued") {
    try {
      await dmcRequest(baseUrl, `v2/video_generation/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
        apiKey,
      });
    } catch {
      // Best effort only: the task may have started between the last poll and timeout.
    }
  }
  // INC-0831：超时不再单方面宣判失败——带上 task id 让对帐循环接手查上游真相
  //（上游任务在轮询窗口外照样会跑完）。
  throw new SupplierRequestError(`DMC video generation timed out after ${Math.round(DMC_MAX_WAIT_MS / 1000)}s.`, 504, undefined, undefined, undefined, taskId);
}

function readDmcCredential(supplier: SupplierRecord): string {
  const value = process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef] ?? "";
  if (!value.trim()) {
    throw new SupplierRequestError(`Missing configured credential ${supplier.account.credentialRef}.`, 401);
  }
  return value.trim();
}

async function dmcRequest(
  baseUrl: string,
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; apiKey: string; body?: string; signal?: AbortSignal; idempotencyKey?: string },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${init.apiKey}`,
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey, "X-Request-ID": init.idempotencyKey } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(DMC_REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new SupplierRequestError("DMC request timed out.", 408);
    }
    throw new SupplierRequestError("DMC submission transport outcome is unknown.", 408, null, undefined, "unknown");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // 4xx 保留上游原 status。只有 5xx 或拿不到成功体的解析失败才用 502。
    const status = response.status >= 400 && response.status <= 499 ? response.status : 502;
    throw new SupplierRequestError(
      `DMC returned invalid JSON (HTTP ${response.status}).`,
      status,
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
        : `DMC API request failed with HTTP ${response.status}.`;
    // 4xx 保留原 status。5xx 才记 502。upstreamStatus 仍带上游原文。
    throw new SupplierRequestError(
      message,
      response.status >= 400 && response.status <= 499 ? response.status : 502,
      null,
      undefined,
      undefined,
      undefined,
      response.status,
    );
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SupplierRequestError("DMC returned a non-object response.", 502);
  }
  return payload as Record<string, unknown>;
}

/**
 * INC-0831 对帐轮询：按 task id 查 dmc 任务真相（provider-reconciliation 用，
 * 只读不改任何任务状态）。响应解析与 generateWithDmc 同源；查无 task 行时
 * 保守视为仍在跑（宁可冻结到对帐窗口耗尽，不假宣判失败退款）。
 */
export async function pollDmcTask(
  supplier: SupplierRecord,
  providerTaskId: string,
): Promise<ProviderTaskPollResult> {
  const apiKey = readDmcCredential(supplier);
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "");
  const response = await dmcRequest(baseUrl, `v2/query/video_generation/${encodeURIComponent(providerTaskId)}`, {
    method: "GET",
    apiKey,
  });
  if (!response.task || typeof response.task !== "object" || Array.isArray(response.task)) {
    return { state: "running" };
  }
  const task = response.task as DmcTask;
  const status = String(task.status ?? "").trim();
  if (status === "succeeded") {
    const outputUrl = String(task.content?.url ?? "").trim();
    if (!outputUrl.startsWith("http://") && !outputUrl.startsWith("https://")) {
      return { state: "failed", reason: "DMC succeeded response is missing content.url." };
    }
    return { state: "succeeded", url: outputUrl, base64: null };
  }
  if (status === "failed") {
    const code = typeof task.error?.code === "string" ? task.error.code : "task_failed";
    const detail = typeof task.error?.message === "string" ? task.error.message : "DMC video generation failed";
    return { state: "failed", reason: `DMC task failed (${code}): ${detail}` };
  }
  if (status === "cancelled") {
    return { state: "failed", reason: "DMC video generation was cancelled." };
  }
  return { state: "running" };
}
