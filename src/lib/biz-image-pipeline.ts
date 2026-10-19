// B 端生图的上游调用与故障转移。
//
// 队列与端点健康记忆不再是本文件的私货：channel-registry 是唯一的队列来源
// （/api/generate-images、/admin 路由调度面板、上游探测用的都是同一个
// buildModelQueue），冷却记忆也是同一份 Map——用户管线撞到的坏端点，B 端
// 管线不必再亲自撞一次。真正涉及钱的部分（reserve/refund）本来就在共用 lib。
// 本文件剩下的职责只有：预算控制的重试循环 + 上游请求协议。

import { getRuntimeGatewayPools } from "./admin-pool-store";
import { getRuntimeChannelOverrides } from "./channel-overrides";
import {
  buildModelQueue,
  isEndpointCoolingDown,
  prioritizeHealthyEndpoints,
  recordEndpointFailure,
  recordEndpointSuccess,
  safeEndpointHost,
  __resetChannelHealthForTests,
} from "./channel-registry";
import { recordRoutingEvent, type RoutingAttempt } from "./routing-telemetry";
import { type GatewayEndpoint } from "./sub2api";
import { publicImageUrl } from "./image-url";
import type { PixaiControlNetEntry } from "./pixai-controlnets";
import {
  resolveUpstreamModelId,
  type ModelMode,
} from "./provider-config";
import { aspectRatioFromImageSize } from "./generation-model-catalog";
import { resolveAdobe2ApiModelId } from "./generation-core/adobe2api-upstream";

/** 与 /api/generate-images 保持一致的预算参数（v1/route.test.ts 钉两边同值）。 */
export const BIZ_UPSTREAM_BUDGET_MS = 240_000;
export const BIZ_MIN_ATTEMPT_BUDGET_MS = 15_000;
export const BIZ_UPSTREAM_TIMEOUT_MS = 100_000;

const IMAGE_GENERATIONS_PATH = "/images/generations";

export class BizUpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "BizUpstreamError";
  }
}

/** 兼容旧导出名——host 格式化已统一到 channel-registry。 */
export const safeEndpointName = safeEndpointHost;

/** 仅供测试使用（共享冷却状态现由 channel-registry 持有）。 */
export const __resetBizPipelineForTests = __resetChannelHealthForTests;

// ─────────────────────────────────────────────────────────── 端点队列

export async function resolveBizEndpoints(modelId: string): Promise<GatewayEndpoint[]> {
  // 与用户管线同源：同一个 buildModelQueue、同一份 admin overrides、同一份冷却记忆。
  const [pools, overrides] = await Promise.all([getRuntimeGatewayPools(), getRuntimeChannelOverrides()]);
  return prioritizeHealthyEndpoints(buildModelQueue(modelId, process.env, pools, overrides));
}

// ─────────────────────────────────────────────────────────── 上游调用

interface UpstreamPayload {
  data?: Array<{ b64_json?: string; url?: string }>;
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function readUpstreamPayload(response: Response): Promise<UpstreamPayload | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as UpstreamPayload;
  } catch {
    // 上游偶尔在网关层返回 HTML 错误页，此时把片段带进错误信息便于排查。
    if (!response.ok) throw new BizUpstreamError(text.slice(0, 300), response.status);
    return null;
  }
}

export interface BizGenerationResult {
  image: string | null;
  imageUrl: string | null;
  upstreamModelId: string;
  endpointLabel: string;
  upstreamElapsedMs: number;
}

async function requestOnce(
  endpoint: GatewayEndpoint,
  prompt: string,
  modelId: string,
  imageSize: string,
  qualityMode: ModelMode,
  timeoutMs: number,
  controlNets?: PixaiControlNetEntry[],
): Promise<BizGenerationResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamModelId = endpoint.protocol === "adobe2api"
    ? resolveAdobe2ApiModelId(modelId, aspectRatioFromImageSize(imageSize), qualityMode === "quality" ? "2k" : "1k")
    : resolveUpstreamModelId(modelId, endpoint.modelId);
  if (!upstreamModelId) throw new Error(`Adobe2API does not support ${modelId} ${imageSize}.`);

  let body: string;
  if (endpoint.protocol === "adobe2api") {
    body = JSON.stringify({ model: upstreamModelId, prompt });
  } else {
    const payload: Record<string, unknown> = {
      model: upstreamModelId,
      prompt,
      size: imageSize,
      quality: qualityMode === "quality" ? "high" : "medium",
    };
    // ControlNet 只对 pixai 渠道有意义；pixai 模型在 buildModelQueue 的 supportedModels
    // 白名单里只会落进 pixai 端点，所以 controlNets 不会被喂给不认识它的上游。
    if (controlNets && controlNets.length > 0) payload.controlNets = controlNets;
    body = JSON.stringify(payload);
  }

  try {
    const response = await fetch(`${endpoint.baseURL}${IMAGE_GENERATIONS_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.apiKey}`, "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });

    const payload = await readUpstreamPayload(response);
    if (!response.ok) {
      throw new BizUpstreamError(
        payload?.error?.message ?? `上游 ${endpoint.label} 生图失败。`,
        response.status,
      );
    }
    // 202 Accepted 不是成功：任务已收、成品未回，本管线不轮询。记失败让下一个端点接手。
    if (response.status === 202) {
      throw new BizUpstreamError(
        `上游 ${endpoint.label} 回 HTTP 202（已接受）但未返回图片；本管线不轮询。`,
        202,
      );
    }

    const first = payload?.data?.[0];
    const adobeUrl = payload?.choices?.[0]?.message?.content
      ?.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/)?.[1];
    const imageUrl = publicImageUrl(first?.url ?? adobeUrl);
    if (!first?.b64_json && !imageUrl) {
      throw new Error(`上游 ${endpoint.label} 没有返回图片数据。`);
    }

    return {
      image: first?.b64_json ?? null,
      imageUrl,
      upstreamModelId,
      endpointLabel: endpoint.label,
      upstreamElapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`上游 ${endpoint.label} 超时（${timeoutMs}ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export interface BizGenerationOutcome {
  ok: boolean;
  result?: BizGenerationResult;
  /** 每次尝试的失败原因，用于日志与错误响应。 */
  failures: string[];
}

/**
 * 依次尝试队列里的端点，直到成功或预算耗尽。
 * 调用方负责配额的预留与退款 —— 这里只管把图拿回来。
 */
export async function generateBizImage(options: {
  modelId: string;
  prompt: string;
  imageSize: string;
  qualityMode: ModelMode;
  requestId: string;
  controlNets?: PixaiControlNetEntry[];
}): Promise<BizGenerationOutcome> {
  const { modelId, prompt, imageSize, qualityMode, requestId, controlNets } = options;
  const startedAt = Date.now();
  const endpoints = await resolveBizEndpoints(modelId);
  const routingQueue = endpoints.map((endpoint) => ({
    label: endpoint.label,
    host: safeEndpointName(endpoint.baseURL),
    cooling: isEndpointCoolingDown(endpoint),
  }));
  const attempts: RoutingAttempt[] = [];
  // B 端是服务器对服务器，几十毫秒的同步遥测写入可以接受；换来的是与用户管线
  // 同一条 admin 可见的事件流（pipeline 徽章区分）。coins 由调用方计费，此处记 0。
  // B 端只传 qualityMode（fast/quality），没有真实分辨率档位——与 route.ts 里
  // control-plane 分支（generationCommand.resolution）用同一套映射，保证同一模型
  // 走两条路径时在 /admin 树状图里落进同一个分辨率桶，不会各说各话。
  const resolution = qualityMode === "quality" ? "2k" : "1k";
  const emitEvent = (outcome: "delivered" | "exhausted" | "budget-exhausted" | "no-endpoints", deliveredBy?: string, imageUrls?: string[]) =>
    recordRoutingEvent({
      id: `${Date.now()}-${requestId}`,
      ts: Date.now(),
      requestId,
      pipeline: "biz",
      modelId,
      qualityMode,
      resolution,
      queue: routingQueue,
      attempts,
      outcome,
      ...(deliveredBy ? { deliveredBy } : {}),
      ...(imageUrls && imageUrls.length > 0 ? { imageUrls } : {}),
      totalMs: Date.now() - startedAt,
      coins: 0,
      refunded: false,
    });

  console.log(
    `[biz-api] requestId=${requestId}, model=${modelId}, queue=${
      routingQueue.map((entry) => `${entry.label}@${entry.host}${entry.cooling ? "(cooling)" : ""}`).join(" -> ") || "empty"
    }`,
  );

  if (!endpoints.length) {
    await emitEvent("no-endpoints");
    return { ok: false, failures: [`没有为 ${modelId} 配置可用的上游端点。`] };
  }

  const deadline = Date.now() + BIZ_UPSTREAM_BUDGET_MS;
  const failures: string[] = [];
  let budgetExhausted = false;

  for (const endpoint of endpoints) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < BIZ_MIN_ATTEMPT_BUDGET_MS) {
      budgetExhausted = true;
      failures.push(`预算 ${BIZ_UPSTREAM_BUDGET_MS}ms 在 ${endpoint.label} 之前已耗尽`);
      break;
    }

    const attemptStartedAt = Date.now();
    try {
      const result = await requestOnce(
        endpoint,
        prompt,
        modelId,
        imageSize,
        qualityMode,
        Math.min(BIZ_UPSTREAM_TIMEOUT_MS, remainingMs),
        controlNets,
      );
      recordEndpointSuccess(endpoint);
      attempts.push({ label: endpoint.label, host: safeEndpointName(endpoint.baseURL), ok: true, ms: result.upstreamElapsedMs });
      await emitEvent("delivered", endpoint.label, result.imageUrl ? [result.imageUrl] : undefined);
      return { ok: true, result, failures };
    } catch (error) {
      recordEndpointFailure(endpoint);
      attempts.push({
        label: endpoint.label,
        host: safeEndpointName(endpoint.baseURL),
        ok: false,
        ms: Date.now() - attemptStartedAt,
        ...(error instanceof BizUpstreamError ? { status: error.status } : {}),
        reason: error instanceof BizUpstreamError
          ? `http-${error.status}`
          : error instanceof Error && error.message.includes("超时")
            ? "timeout"
            : "upstream-error",
      });
      failures.push(
        error instanceof BizUpstreamError
          ? `${endpoint.label}: HTTP ${error.status}`
          : error instanceof Error && error.message.includes("超时")
            ? `${endpoint.label}: timeout`
            : `${endpoint.label}: upstream error`,
      );
    }
  }

  await emitEvent(budgetExhausted ? "budget-exhausted" : "exhausted");
  return { ok: false, failures };
}
