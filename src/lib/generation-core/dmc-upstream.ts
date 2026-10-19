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
// 2026-10-20 auto-hd 超分（实测契约见记忆 2026-10-20-dmc-auto-hd-verified-contract）：
//   H3 只出 768P。平台 1080p/2k/4k 档＝「H3 出 768P → auto-hd 超分」两段链路：
//     POST {base}/hd/tasks        {model:"auto-hd", video_url, resolution, duration} → {id}
//     GET  {base}/hd/tasks/{id}   → {status}；FINISHED 时带 url（**相对路径**，
//                                  必须用同一 Bearer 下载，无鉴权 401）
//   H3 成片是公网无鉴权 COS URL（auto-hd 直接可读）；超分成片必须带上
//   `downloadHeaders` 交给 worker 的鉴权下载。**该栏位含 secret，绝不入
//   evidence／provider_result_json／加密 receipt／日志**（worker 负责剥离）。
//
// 对帐指针（INC-0831）在两段链路下用可辨识前缀编码：
//   hdx:<target>:<h3TaskId>  ＝H3 已提交、auto-hd 尚未提交（真相仍在 H3）
//   hdh:<target>:<hdTaskId>  ＝auto-hd 已提交、真相已推进到 hd task
// 裸 task id 继续按 /v2 查询（旧 DB 行兼容）。
//
// 轮子真源＝metaso-upstream.ts（逐行等价，白名单外零改动）；差异仅三项：
//   ① 上游模型名与错误文案用 dmc；
//   ② 分辨率：dmc 只出 768P（无 2K）⇒ 720p 直出，1080p/2k/4k 走 auto-hd，其余拒收；
//   ③ 参考图：dmc 文档允许最多 9 张参考图。≤2 张沿用 metaso 的首/尾帧位契约
//      （「上游按位置解读」，见 blender-to-video-bridge.ts:6-11）；≥3 张因
//      first_frame/last_frame 不得与 reference_* 混用（dmc 文档 §5），整批改走
//      reference_image（保序）。

const DMC_API_MODEL = "MiniMax-H3";
const DMC_HD_API_MODEL = "auto-hd";
const DMC_POLL_INTERVAL_MS = 5_000;
// 平台 video 上游超时 600s；轮询上限压到 540s 留出 create/查询余量。
const DMC_MAX_WAIT_MS = 540_000;
const DMC_REQUEST_TIMEOUT_MS = 30_000;
const DMC_ALLOWED_RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const DMC_MAX_REFERENCE_IMAGES = 9;
// dmc 只提供 768P 画布；平台 minimax-h3 catalog 的 720p 档即映射到此。
const DMC_RESOLUTION: Record<string, string> = { "720p": "768P", "768p": "768P" };
// 2026-10-20：这三档＝H3 出 768P 后交 auto-hd 超分（resolution 原样传给 /hd/tasks）。
const DMC_UPSCALE_RESOLUTIONS = new Set(["1080p", "2k", "4k"]);
const DMC_H3_UPSCALE_REF_PREFIX = "hdx:";
const DMC_HD_REF_PREFIX = "hdh:";
const DMC_HD_POLL_INTERVAL_MS = 5_000;
// auto-hd 实测 1080p(5.2s)≈30s、4k(10s)≈67s；上限按 4k 长片（15s）放宽到 30 分钟
// （worker 的 25 分钟生成预算先到时会转对帐，hd 指针已落库，不会丢任务）。
const DMC_HD_MAX_WAIT_MS = 30 * 60_000;

type DmcUpscaleTarget = "1080p" | "2k" | "4k";

interface DmcTask {
  status?: unknown;
  content?: { url?: unknown } | null;
  error?: { code?: unknown; message?: unknown } | null;
  resolution?: unknown;
  duration?: unknown;
  ratio?: unknown;
  modality?: unknown;
}

/** 对帐指针编码（provider_task_id 里的一整条字符串）。 */
interface DmcTaskRef {
  kind: "h3" | "hd";
  target: DmcUpscaleTarget;
  taskId: string;
}

/** /hd/tasks 的只读解读结果（worker 内轮询与对帐共用同一套状态语义）。 */
type DmcHdOutcome =
  | { state: "running" }
  | { state: "finished"; url: string }
  | { state: "failed"; reason: string };

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
  const requestedResolution = (input.resolution ?? "").toLowerCase();
  const upscaleTarget = upscaleTargetOf(requestedResolution);
  const resolution = DMC_RESOLUTION[requestedResolution] ?? DMC_RESOLUTION["720p"];
  if (requestedResolution && !DMC_RESOLUTION[requestedResolution] && !upscaleTarget) {
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
  // 超分单：对帐指针编码目标档位（H3 已完成前真相仍在 H3；裸 id 留给普通单兼容旧行）。
  const h3Ref = upscaleTarget ? dmcUpscaleRef("h3", upscaleTarget, taskId.trim()) : taskId.trim();
  // INC-0831：上游任务已提交 → worker durably 落 attempt 行（task id + 对帐排程）。
  await input.onProviderTaskSubmitted?.(h3Ref, "dmc");

  const deadline = Date.now() + DMC_MAX_WAIT_MS;
  let lastStatus: string | undefined;
  let h3OutputUrl: string | null = null;
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    const response = await dmcRequest(baseUrl, `v2/query/video_generation/${encodeURIComponent(taskId)}`, {
      method: "GET",
      apiKey,
    });
    if (!response.task || typeof response.task !== "object" || Array.isArray(response.task)) {
      throw new SupplierRequestError("DMC query response is missing task.", 502, undefined, undefined, undefined, h3Ref);
    }
    const task = response.task as DmcTask;
    const status = String(task.status ?? "").trim();
    lastStatus = status;

    if (status === "succeeded") {
      if (task.modality != null && task.modality !== "video") {
        throw new SupplierRequestError("DMC returned a non-video result for video generation.", 502, undefined, undefined, undefined, h3Ref);
      }
      const outputUrl = String(task.content?.url ?? "").trim();
      if (!outputUrl.startsWith("http://") && !outputUrl.startsWith("https://")) {
        throw new SupplierRequestError("DMC succeeded response is missing content.url.", 502, undefined, undefined, undefined, h3Ref);
      }
      h3OutputUrl = outputUrl;
      break;
    }

    if (status === "failed") {
      const code = typeof task.error?.code === "string" ? task.error.code : "task_failed";
      const detail = typeof task.error?.message === "string" ? task.error.message : "DMC video generation failed";
      throw new SupplierRequestError(`DMC task failed (${code}): ${detail}`, 502, undefined, undefined, undefined, h3Ref);
    }
    if (status === "cancelled") {
      throw new SupplierRequestError("DMC video generation was cancelled.", 502, undefined, undefined, undefined, h3Ref);
    }
    if (status !== "queued" && status !== "running") {
      throw new SupplierRequestError(`DMC returned an unknown task status: ${status}`, 502, undefined, undefined, undefined, h3Ref);
    }
    await new Promise((resolve) => setTimeout(resolve, DMC_POLL_INTERVAL_MS));
  }

  if (!h3OutputUrl) {
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
    throw new SupplierRequestError(`DMC video generation timed out after ${Math.round(DMC_MAX_WAIT_MS / 1000)}s.`, 504, undefined, undefined, undefined, h3Ref);
  }

  if (!upscaleTarget) {
    return {
      base64: null,
      url: h3OutputUrl,
      providerTaskId: taskId,
      httpStatus: 200,
      endpointLabel: supplier.label,
      supplierModelId: DMC_API_MODEL,
    };
  }

  // ── 第二段：auto-hd 超分（H3 已出 768P，此后真相在 hd task）──
  let hdTaskId: string;
  try {
    const hdCreate = await dmcRequest(baseUrl, "hd/tasks", {
      method: "POST",
      apiKey,
      signal: input.signal,
      idempotencyKey: `${input.idempotencyKey ?? input.attemptId}:hd:${upscaleTarget}`,
      body: JSON.stringify({
        model: DMC_HD_API_MODEL,
        video_url: h3OutputUrl,
        resolution: upscaleTarget,
        duration,
      }),
    });
    hdTaskId = String(hdCreate.id ?? hdCreate.task_id ?? "").trim();
  } catch (error) {
    // 失败路径会把 error.providerTaskId 写回 attempt：必须保住 hdx 指针
    //（否则 H3 已完成、超分未提交的真相会被抹掉）。
    throw withDmcTaskRef(error, h3Ref);
  }
  if (!hdTaskId) {
    throw new SupplierRequestError("DMC auto-hd create response is missing id.", 502, undefined, undefined, undefined, h3Ref);
  }
  const hdRef = dmcUpscaleRef("hd", upscaleTarget, hdTaskId);
  // 对帐指针 CAS 推进：只允许从 hdx 期望值推进到 hdh（H3 已完成，此后真相在 hd task）。
  await input.onProviderTaskSubmitted?.(hdRef, "dmc", { replacePrevious: h3Ref });

  const finalUrl = await waitForDmcHdTask({ baseUrl, apiKey, hdTaskId, providerTaskId: hdRef, target: upscaleTarget, signal: input.signal });
  return {
    base64: null,
    url: finalUrl,
    // 上游成片是相对路径 + Bearer 鉴权（无鉴权 401）：下载头只交给 persistOutputArtifact。
    downloadHeaders: { Authorization: `Bearer ${apiKey}` },
    providerTaskId: hdRef,
    httpStatus: 200,
    endpointLabel: supplier.label,
    supplierModelId: DMC_API_MODEL,
  };
}

function readDmcCredential(supplier: SupplierRecord): string {
  const value = process.env[supplier.account.credentialRef] ?? process.env[supplier.credentialRef] ?? "";
  if (!value.trim()) {
    throw new SupplierRequestError(`Missing configured credential ${supplier.account.credentialRef}.`, 401);
  }
  return value.trim();
}

function upscaleTargetOf(resolution: string): DmcUpscaleTarget | null {
  return DMC_UPSCALE_RESOLUTIONS.has(resolution) ? (resolution as DmcUpscaleTarget) : null;
}

function dmcUpscaleRef(kind: "h3" | "hd", target: DmcUpscaleTarget, taskId: string): string {
  return `${kind === "h3" ? DMC_H3_UPSCALE_REF_PREFIX : DMC_HD_REF_PREFIX}${target}:${taskId}`;
}

/** 解析对帐指针前缀；不是本适配器编码的形态（含全部裸 id）返回 null＝走旧 /v2 查询。 */
function parseDmcUpscaleRef(value: string): DmcTaskRef | null {
  const candidates: Array<{ prefix: string; kind: "h3" | "hd" }> = [
    { prefix: DMC_H3_UPSCALE_REF_PREFIX, kind: "h3" },
    { prefix: DMC_HD_REF_PREFIX, kind: "hd" },
  ];
  for (const candidate of candidates) {
    if (!value.startsWith(candidate.prefix)) continue;
    const rest = value.slice(candidate.prefix.length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return null;
    const target = upscaleTargetOf(rest.slice(0, separator));
    const taskId = rest.slice(separator + 1).trim();
    if (!target || !taskId) return null;
    return { kind: candidate.kind, target, taskId };
  }
  return null;
}

/** 上游相对路径（/v1/tasks/…/content）拼成绝对 URL；已是绝对 URL 则原样返回。 */
function absoluteDmcUrl(baseUrl: string, raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${baseUrl}/${raw.replace(/^\/+/, "")}`;
}

/**
 * 读取 /hd/tasks 的状态与成片路径。建任务后前 ~20s 可能只回 `{id, model}`
 *（无 status）⇒ 状态为空＝进行中，绝不能当失败。
 */
function readDmcHdTask(payload: Record<string, unknown>): { status: string; url: string } {
  const nested = payload.task;
  const body = (nested && typeof nested === "object" && !Array.isArray(nested) ? nested : payload) as Record<string, unknown>;
  const status = typeof body.status === "string" ? body.status.trim().toUpperCase() : "";
  const rawUrl = body.url ?? body.output_url ?? body.video_url;
  return { status, url: typeof rawUrl === "string" ? rawUrl.trim() : "" };
}

/** /hd/tasks 状态语义（单一真源）：FINISHED＝成功；FAILED/ERROR/CANCELLED＝失败（上游无原因字段）。 */
function interpretDmcHdTask(payload: Record<string, unknown>, baseUrl: string, hdTaskId: string): DmcHdOutcome {
  const { status, url } = readDmcHdTask(payload);
  if (status === "FINISHED" || status === "SUCCEEDED" || status === "SUCCESS") {
    if (!url) return { state: "failed", reason: `DMC auto-hd task ${hdTaskId} finished without an artifact url.` };
    return { state: "finished", url: absoluteDmcUrl(baseUrl, url) };
  }
  if (status === "FAILED" || status === "ERROR" || status === "CANCELLED" || status === "CANCELED") {
    return { state: "failed", reason: `DMC auto-hd task ${hdTaskId} ended with status ${status}; upstream exposes no failure reason.` };
  }
  return { state: "running" };
}

/** 轮询 auto-hd 直到 FINISHED；失败/超时抛 SupplierRequestError（reason 带 hd task id 便于人工对帐）。 */
async function waitForDmcHdTask(input: {
  baseUrl: string;
  apiKey: string;
  hdTaskId: string;
  providerTaskId: string;
  target: DmcUpscaleTarget;
  signal?: AbortSignal;
}): Promise<string> {
  const deadline = Date.now() + DMC_HD_MAX_WAIT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    const response = await dmcRequest(input.baseUrl, `hd/tasks/${encodeURIComponent(input.hdTaskId)}`, {
      method: "GET",
      apiKey: input.apiKey,
    });
    const outcome = interpretDmcHdTask(response, input.baseUrl, input.hdTaskId);
    if (outcome.state === "finished") return outcome.url;
    if (outcome.state === "failed") {
      throw new SupplierRequestError(outcome.reason, 502, undefined, undefined, undefined, input.providerTaskId);
    }
    lastStatus = readDmcHdTask(response).status || lastStatus;
    await new Promise((resolve) => setTimeout(resolve, DMC_HD_POLL_INTERVAL_MS));
  }
  throw new SupplierRequestError(
    `DMC auto-hd ${input.target} task ${input.hdTaskId} timed out after ${Math.round(DMC_HD_MAX_WAIT_MS / 1000)}s (last status: ${lastStatus || "unknown"}).`,
    504,
    undefined,
    undefined,
    undefined,
    input.providerTaskId,
  );
}

/** 给 SupplierRequestError 补上已落库的对帐指针（失败路径据此回填 provider_task_id）。 */
function withDmcTaskRef(error: unknown, providerTaskId: string): unknown {
  if (error instanceof SupplierRequestError && !error.providerTaskId) {
    return new SupplierRequestError(
      error.message,
      error.status,
      error.retryAfter,
      error.responseBody,
      error.explicitClass,
      providerTaskId,
      error.upstreamStatus,
    );
  }
  return error;
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
 *
 * 三种指针语义（2026-10-20 auto-hd）：
 *   - 裸 id：/v2 查询，行为与旧版一字不变（旧 DB 行兼容）。
 *   - hdx:<target>:<h3Id>：只轮 H3。**H3 succeeded ⇒ 返回 failed**（「H3 出完
 *     768P 但超分从未提交」＝控制面中断），按失败退款；绝不把 768P 冒充 HD 交付。
 *   - hdh:<target>:<hdId>：轮 /hd/tasks；FINISHED ⇒ succeeded（带鉴权下载头）。
 */
export async function pollDmcTask(
  supplier: SupplierRecord,
  providerTaskId: string,
): Promise<ProviderTaskPollResult> {
  const apiKey = readDmcCredential(supplier);
  const baseUrl = supplier.baseUrl.replace(/\/+$/, "");
  const ref = parseDmcUpscaleRef(providerTaskId);

  if (ref?.kind === "h3") {
    const response = await dmcRequest(baseUrl, `v2/query/video_generation/${encodeURIComponent(ref.taskId)}`, {
      method: "GET",
      apiKey,
    });
    if (!response.task || typeof response.task !== "object" || Array.isArray(response.task)) {
      return { state: "running" };
    }
    const task = response.task as DmcTask;
    const status = String(task.status ?? "").trim();
    if (status === "succeeded") {
      // 禁止把低清冒充高清：H3 已完成即证明「超分未提交」，按失败退款。
      return {
        state: "failed",
        reason: `DMC H3 task ${ref.taskId} completed but auto-hd ${ref.target} super-resolution was never submitted (control-plane interrupted between stages); refund and do not deliver 768P as ${ref.target}.`,
      };
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

  if (ref?.kind === "hd") {
    const response = await dmcRequest(baseUrl, `hd/tasks/${encodeURIComponent(ref.taskId)}`, {
      method: "GET",
      apiKey,
    });
    const outcome = interpretDmcHdTask(response, baseUrl, ref.taskId);
    if (outcome.state === "finished") {
      return {
        state: "succeeded",
        url: outcome.url,
        base64: null,
        // 超分成片必须带同一 Bearer 下载（无鉴权 401）；只进 fetch，不落库。
        downloadHeaders: { Authorization: `Bearer ${apiKey}` },
      };
    }
    if (outcome.state === "failed") return { state: "failed", reason: outcome.reason };
    return { state: "running" };
  }

  // 裸 id（旧行）：原样 /v2 行为。
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
