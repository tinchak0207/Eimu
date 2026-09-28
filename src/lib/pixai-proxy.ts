// PixAI bridge 的服務端代理。
//
// 這個檔案與同目錄下的 4 個 /v1 路由曾經只存在於 VPS 上的 control plane，
// 不在 repo 裡（2026-08-05 排障時發現）。後果有兩個：
//   1. 從 repo 部署會直接刪掉生產上正在工作的 edits/upscale/templates
//   2. 這些路由裡 `const coins = …` 算完從未使用 —— B 端改圖/放大/模板
//      一直是免費的，賬對不上
// 補回 repo 的同時把計費接上真實通道。
//
// 2026-09-28（V-07）：扣退款已移出本檔——供給模組不碰錢。同步路由改呼叫生產平面
// 門面 generation-core/sync-charge.ts（經 billing-ledger，留 billing_operation 列）。
// 本檔只剩上游呼叫與錯誤體形狀。

import { NextResponse } from "next/server";
import { pixaiBridgeModelId } from "@/lib/pixai-model-map";
import { withTraceId } from "@/lib/request-trace";

/**
 * env 在函數內讀，不在模組頂層。
 *
 * 頂層讀取會把值凍結在模組載入那一刻：容器改了 env 但沒重啟、或測試想換
 * 配置，都會拿到過期值 —— 而症狀是「配置明明對的但 503」。
 */
function bridgeConfig(): { base: string; key: string } | null {
  // 歸一到不含 /v1 的根，拼接處統一 `${base}/v1/${action}`。控制面 env 的
  // PIXAI_BASE_URL 帶 /v1 後綴（lora 路由 `${base}/lora-models` 的慣例），
  // 這裡曾直接再拼 /v1/ 造成 /v1/v1/ 雙字首 404 —— 改圖/放大/模板/上傳
  // 全鏈死。strip 後綴讓兩種 env 寫法都正確。
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
 * 把公開模型名歸一成 bridge 認的名字。
 *
 * 未傳 model 時返回 undefined，交給 bridge 用它自己的默認模型；傳了但不認識
 * 的返回 null，讓路由回 400 —— 而不是把一個 bridge 不認的名字丟過去，
 * 換回一條「Unknown model」的上游錯誤讓客戶去猜。
 */
export function resolveBridgeModel(raw: unknown): string | null | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return pixaiBridgeModelId(raw);
}

/**
 * 統一的錯誤體。
 *
 * 與 /v1/images/generations 的 errorResponse 逐字段對齊：同樣的
 * `{ error: { message, type, code, param, trace_id } }`。原本這邊少了
 * `param` 與 `trace_id`，客戶要按端點分兩套解析邏輯，報障時也給不出
 * 能跨層追的 id —— 而耐久路由那邊早就有了。
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

/** 請求參數錯誤。與耐久路由的 invalid_request_error 同形。 */
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
 * 認證/限流錯誤。type 的映射與耐久路由一致：
 * 429 → rate_limit_error，403 → permission_error，其餘 → authentication_error。
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

/** 帶 trace id 的響應。同一個 id 同時進錯誤體與 X-Request-Id 頭。 */
export function jsonWithTrace(data: unknown, status: number, traceId: string, headers?: Record<string, string>) {
  return withTraceId(NextResponse.json(data, { status, ...(headers ? { headers } : {}) }), traceId);
}
