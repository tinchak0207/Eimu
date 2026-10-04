// PixAI bridge 的服务端代理。
//
// 这个档案与同目录下的 4 个 /v1 路由曾经只存在于 VPS 上的 control plane，
// 不在 repo 里（2026-08-05 排障时发现）。后果有两个：
//   1. 从 repo 部署会直接删掉生产上正在工作的 edits/upscale/templates
//   2. 这些路由里 `const coins = …` 算完从未使用 —— B 端改图/放大/模板
//      一直是免费的，账对不上
// 补回 repo 的同时把计费接上真实通道。
//
// 2026-09-28（V-07）：扣退款已移出本档——供给模组不碰钱。同步路由改呼叫生产平面
// 门面 generation-core/sync-charge.ts（经 billing-ledger，留 billing_operation 列）。
// 本档只剩上游呼叫与错误体形状。

import { NextResponse } from "next/server";
import { pixaiBridgeModelId } from "@/lib/pixai-model-map";
import { withTraceId } from "@/lib/request-trace";

/**
 * env 在函数内读，不在模组顶层。
 *
 * 顶层读取会把值冻结在模组载入那一刻：容器改了 env 但没重启、或测试想换
 * 配置，都会拿到过期值 —— 而症状是「配置明明对的但 503」。
 */
function bridgeConfig(): { base: string; key: string } | null {
  // 归一到不含 /v1 的根，拼接处统一 `${base}/v1/${action}`。控制面 env 的
  // PIXAI_BASE_URL 带 /v1 后缀（lora 路由 `${base}/lora-models` 的惯例），
  // 这里曾直接再拼 /v1/ 造成 /v1/v1/ 双字首 404 —— 改图/放大/模板/上传
  // 全链死。strip 后缀让两种 env 写法都正确。
  const base = process.env.PIXAI_BASE_URL?.trim().replace(/\/+$/, "").replace(/\/v1$/, "") ?? "";
  const key = process.env.PIXAI_API_KEY?.trim() ?? "";
  return base && key ? { base, key } : null;
}

export type PixaiProxyResult = { status: number; data: unknown };

export async function proxyPixai(
  action: string,
  body: unknown,
  method: "POST" | "GET" = "POST",
): Promise<PixaiProxyResult> {
  const config = bridgeConfig();
  if (!config) {
    return { status: 503, data: { error: { message: "PixAI bridge is not configured." } } };
  }
  try {
    const resp = await fetch(`${config.base}/v1/${action}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.key}`,
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(280_000),
    });
    const data = await resp.json().catch(() => null);
    return { status: resp.status, data };
  } catch {
    return { status: 502, data: { error: { message: "PixAI bridge request failed." } } };
  }
}

/**
 * 把公开模型名归一成 bridge 认的名字。
 *
 * 未传 model 时返回 undefined，交给 bridge 用它自己的默认模型；传了但不认识
 * 的返回 null，让路由回 400 —— 而不是把一个 bridge 不认的名字丢过去，
 * 换回一条「Unknown model」的上游错误让客户去猜。
 */
export function resolveBridgeModel(raw: unknown): string | null | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return pixaiBridgeModelId(raw);
}

/**
 * 统一的错误体。
 *
 * 与 /v1/images/generations 的 errorResponse 逐字段对齐：同样的
 * `{ error: { message, type, code, param, trace_id } }`。原本这边少了
 * `param` 与 `trace_id`，客户要按端点分两套解析逻辑，报障时也给不出
 * 能跨层追的 id —— 而耐久路由那边早就有了。
 */
export function pixaiError(data: unknown, fallback: string, traceId?: string) {
  const d = data as { error?: { message?: string; code?: string; type?: string } } | null;
  return {
    error: {
      message: d?.error?.message ?? fallback,
      type: d?.error?.type ?? "api_error",
      code: d?.error?.code ?? "pixai_bridge_error",
      param: null,
      ...(traceId ? { trace_id: traceId } : {}),
    },
  };
}

/** 请求参数错误。与耐久路由的 invalid_request_error 同形。 */
export function pixaiRequestError(message: string, code: string, traceId?: string) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      code,
      param: null,
      ...(traceId ? { trace_id: traceId } : {}),
    },
  };
}

/**
 * 认证/限流错误。type 的映射与耐久路由一致：
 * 429 → rate_limit_error，403 → permission_error，其余 → authentication_error。
 */
export function pixaiAuthError(
  status: number,
  message: string,
  code: string,
  traceId?: string,
) {
  const type = status === 429 ? "rate_limit_error" : status === 403 ? "permission_error" : "authentication_error";
  return { error: { message, type, code, param: null, ...(traceId ? { trace_id: traceId } : {}) } };
}

export function json(data: unknown, status: number, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, ...(headers ? { headers } : {}) });
}

/** 带 trace id 的响应。同一个 id 同时进错误体与 X-Request-Id 头。 */
export function jsonWithTrace(data: unknown, status: number, traceId: string, headers?: Record<string, string>) {
  return withTraceId(NextResponse.json(data, { status, ...(headers ? { headers } : {}) }), traceId);
}
