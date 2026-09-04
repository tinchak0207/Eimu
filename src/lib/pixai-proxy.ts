// PixAI bridge 的服務端代理。
//
// 這個檔案與同目錄下的 4 個 /v1 路由曾經只存在於 VPS 上的 control plane，
// 不在 repo 裡（2026-08-05 排障時發現）。後果有兩個：
//   1. 從 repo 部署會直接刪掉生產上正在工作的 edits/upscale/templates
//   2. 這些路由裡 `const coins = …` 算完從未使用 —— B 端改圖/放大/模板
//      一直是免費的，賬對不上
// 補回 repo 的同時把計費接上真實通道（見 chargeBizRequest）。

import { NextResponse } from "next/server";
import { configuredGenerationBillingAdapter } from "@/lib/generation-core/billing-relay";
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

export type BizCharge = {
  /** 已扣的配額，失敗時原數退回。 */
  reservedQuota: number;
  /** 這次扣費的冪等鍵，退款要用同一個。 */
  jobId: string;
};

export type BizChargeResult =
  | { ok: true; charge: BizCharge }
  | { ok: false; status: number; body: unknown };

/**
 * 同步路由的 B 端扣費。
 *
 * 走 configuredGenerationBillingAdapter：control plane 上它解析成 billing
 * relay（HMAC 簽名回打 Vercel 的 /api/internal/generation-billing），因為
 * GATEWAY_ADMIN_ACCESS_TOKEN 只在 Vercel 側。這是 control plane 唯一能真正
 * 扣到錢的通道 —— 直連網關會因為缺 token 靜默失敗。
 *
 * userId 為 0 表示這把 key 來自 BIZ_API_KEY_HASHES 且沒帶 userId（應急格式
 * `sha256` 或 `sha256:0`）。這種 key 無從計費，直接放行但明確記錄：
 * 應急通道優先保可用性，賬留給 admin 對。
 */
export async function chargeBizRequest(input: {
  userId: number;
  quota: number;
  keyId: string;
  action: string;
}): Promise<BizChargeResult> {
  if (input.quota <= 0) {
    return { ok: true, charge: { reservedQuota: 0, jobId: "" } };
  }
  if (!input.userId) {
    console.warn(
      `[pixai-proxy] uncharged request action=${input.action} keyId=${input.keyId} quota=${input.quota}`
      + " reason=env_fallback_key_without_user_id",
    );
    return { ok: true, charge: { reservedQuota: 0, jobId: "" } };
  }

  // relay 要求 job_id 長度 8..128，且用它做冪等鍵。
  const jobId = `pixai-${input.action.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await configuredGenerationBillingAdapter().reserve({
      jobId,
      operation: "reserve",
      userId: input.userId,
      amount: input.quota,
    });
    return { ok: true, charge: { reservedQuota: input.quota, jobId } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Billing failed.";
    return {
      ok: false,
      status: 402,
      body: { error: { message, type: "insufficient_quota", code: "insufficient_quota" } },
    };
  }
}

/**
 * 上游失敗後退款。
 *
 * 吞掉退款自身的異常並記錄：退款失敗不應該把「上游失敗」這條更有用的錯誤
 * 蓋掉。丟掉的賬留在日誌裡，由 admin 的 billing-operations 面板兜。
 */
export async function refundBizRequest(charge: BizCharge, userId: number, action: string): Promise<void> {
  if (!charge.reservedQuota || !charge.jobId || !userId) return;
  try {
    await configuredGenerationBillingAdapter().refund({
      jobId: charge.jobId,
      operation: "refund",
      userId,
      amount: charge.reservedQuota,
    });
  } catch (error) {
    console.error(
      `[pixai-proxy] refund failed action=${action} userId=${userId} quota=${charge.reservedQuota} jobId=${charge.jobId}`,
      error,
    );
  }
}
