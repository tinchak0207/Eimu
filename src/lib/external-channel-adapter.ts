// 外部自定义上游的生成注入：B 端金钥绑定外部 channel 时，生图流量改走客户自带的
// OpenAI 相容 v1 端点，计费与追踪仍挂在平台。
//
// 合约：外部上游是 OpenAI 相容的 /v1/images/generations（非同步或同步都接受——
// 这里只处理「202 带 task」的非同步形状会太窄，先支援两种形状：
//  1. OpenAI 同步：{ data: [{ url | b64_json }] }
//  2. 非同步：{ id, status } 202 → 依 result_url 轮询 { data: [...] }
// 若上游只回其中一种，adapter 对另一种就报「unsupported response shape」，
// 让 route 把失败记进 failures（诚实，不假装成功）。

import type { ExternalChannel } from "./external-channels";
import { externalChannelKeyConfigured, mapExternalModel } from "./external-channels";
import { publicImageUrl } from "./image-url";

export const EXTERNAL_UPSTREAM_TIMEOUT_MS = 30_000;
export const EXTERNAL_POLL_TIMEOUT_MS = 90_000;
export const EXTERNAL_POLL_INTERVAL_MS = 1_500;

export interface ExternalGenerationResult {
  image: string | null;
  imageUrl: string | null;
  upstreamModelId: string;
  endpointLabel: string;
  upstreamElapsedMs: number;
}

export interface ExternalGenerationOutcome {
  ok: boolean;
  result?: ExternalGenerationResult;
  failures: string[];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(response: Response): Promise<string> {
  return response.text();
}

async function requestUpstream(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
  method: "POST" | "GET" = "POST",
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await readText(response);
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`外部上游超时（${timeoutMs}ms）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** 从 OpenAI 同步 response { data: [...] } 抓第一张图。 */
function firstImageFromData(data: unknown): { image: string | null; imageUrl: string | null } | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  if (!isJsonObject(first)) return null;
  const b64 = typeof first.b64_json === "string" && first.b64_json ? first.b64_json : null;
  const url = typeof first.url === "string" && first.url ? publicImageUrl(first.url) : null;
  return { image: b64, imageUrl: url };
}

/**
 * 依外部 channel 生成一张图。回传 OpenAI 相容的失败 failures（route 直接并入既有
 * failures），或成功结果。**任何无法解读的上游回传都记进 failures，不假装成功。**
 */
export async function generateViaExternalChannel(options: {
  channel: ExternalChannel;
  modelId: string;
  prompt: string;
  fetchImpl?: typeof fetch;
}): Promise<ExternalGenerationOutcome> {
  const { channel, modelId, prompt, fetchImpl = fetch } = options;
  const failures: string[] = [];
  const startedAt = Date.now();

  const credential = process.env[channel.credentialRef];
  if (!externalChannelKeyConfigured(channel)) {
    return {
      ok: false,
      failures: [`外部上游 ${channel.name} 的凭证 ${channel.credentialRef} 未设定。`],
    };
  }
  const apiKey = credential as string;
  const upstreamModelId = mapExternalModel(channel, modelId);
  const label = `external:${channel.id}`;

  // 1) POST /images/generations
  let submission: { status: number; payload: unknown };
  try {
    submission = await requestUpstream(
      channel.baseUrl,
      "/images/generations",
      { model: upstreamModelId, prompt, n: 1 },
      apiKey,
      EXTERNAL_UPSTREAM_TIMEOUT_MS,
      "POST",
      fetchImpl,
    );
  } catch (error) {
    return { ok: false, failures: [`${label}: ${error instanceof Error ? error.message : "上游请求失败"}`] };
  }

  // 2a) 同步成功：直接解析 data
  if (submission.status >= 200 && submission.status < 300) {
    const sync = isJsonObject(submission.payload) ? firstImageFromData(submission.payload.data) : null;
    if (sync && (sync.image || sync.imageUrl)) {
      return {
        ok: true,
        result: {
          image: sync.image,
          imageUrl: sync.imageUrl,
          upstreamModelId,
          endpointLabel: label,
          upstreamElapsedMs: Date.now() - startedAt,
        },
        failures,
      };
    }
// 202 + id → 非同步 task
    const task = isJsonObject(submission.payload) ? submission.payload : null;
    if (submission.status === 202 && task && typeof task.id === "string") {
      return pollExternalTask(channel, task.id as string, upstreamModelId, label, apiKey, startedAt, failures, fetchImpl);
    }
    failures.push(`${label}: 上游回传无法解析的资料形状（HTTP ${submission.status}）。`);
    return { ok: false, failures };
  }

  failures.push(`${label}: 上游回传 HTTP ${submission.status}。`);
  return { ok: false, failures };
}

async function pollExternalTask(
  channel: ExternalChannel,
  taskId: string,
  upstreamModelId: string,
  label: string,
  apiKey: string,
  startedAt: number,
  failures: string[],
  fetchImpl: typeof fetch,
): Promise<ExternalGenerationOutcome> {
  const deadline = Date.now() + EXTERNAL_POLL_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadline) {
      failures.push(`${label}: 等待任务 ${taskId} 超过 ${EXTERNAL_POLL_TIMEOUT_MS}ms 仍未终结。`);
      return { ok: false, failures };
    }
    let status: number;
    let payload: unknown;
    try {
      ({ status, payload } = await requestUpstream(
        channel.baseUrl,
        `/images/${taskId}`,
        {},
        apiKey,
        EXTERNAL_UPSTREAM_TIMEOUT_MS,
        "GET",
        fetchImpl,
      ));
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : "轮询失败"}`);
      return { ok: false, failures };
    }
    const task = isJsonObject(payload) ? payload : null;
    const taskStatus = task && typeof task.status === "string" ? (task.status as string) : null;

    if (status >= 200 && status < 300 && taskStatus === "succeeded") {
      const nested = isJsonObject(task) && isJsonObject(task.result) ? task.result.data : undefined;
      const sync = isJsonObject(task) ? firstImageFromData(task.data ?? nested) : null;
      if (sync && (sync.image || sync.imageUrl)) {
        return {
          ok: true,
          result: {
            image: sync.image,
            imageUrl: sync.imageUrl,
            upstreamModelId,
            endpointLabel: label,
            upstreamElapsedMs: Date.now() - startedAt,
          },
          failures,
        };
      }
      failures.push(`${label}: 任务 ${taskId} 成功但无可解析成品。`);
      return { ok: false, failures };
    }
    if (taskStatus === "failed" || taskStatus === "cancelled") {
      failures.push(`${label}: 任务 ${taskId} 状态 ${taskStatus}。`);
      return { ok: false, failures };
    }
    await new Promise((resolve) => setTimeout(resolve, EXTERNAL_POLL_INTERVAL_MS));
  }
}
