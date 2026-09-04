// 手術 P1（CONTROL-PLANE-SURGERY.md）：計費閘拆除的提交路徑插樁。
//
// env SURGERY_QUOTA_PRECHECK=1 時，提交先做一次無狀態配額預檢——只讀 new-api
// users.quota（沿用 gateway-admin fetchGatewayUser 既有通路，即 /v1/quota 的
// 生產讀法，不造新輪子；users.quota 為唯一真源，1 幣 = 500000 quota）：
//   - 額度足夠 → 以 billingAmount=0 提交：createGenerationJob 對 0 額任務直接
//     落 queued（job-repository 零額快車道），阻塞式 reserve 執行器整段被跳過，
//     計費交事後投影（本階段未實現，帳面真源 = new-api logs type=2）；
//     commit/refund 機制原樣保留（0 額時天然 no-op，不動帳）。
//   - 額度不足 → 按現契約 402 insufficient_quota 拒單，不產生註定失敗的 job。
//   - 上游不可達 → 不替閘門做主，原樣回落現行阻塞式 reserve 路徑：現有代碼對
//     new-api 不可用的既有姿勢是歧義結果凍結 billing_unknown、永不盲目重放
//     （billing-ledger classifyBillingFailure）——手術模式不讓可用性變差。
//
// 映射缺失 fail-closed（012 遷移頭註明的承諾）：biz key 無 new-api token 映射
// = 在內核沒有配額執法主體，不許靜默放行；對外沿用既有契約碼 503
// control_plane_unavailable，真因只進日誌。
//
// 0 額任務（今日 TTS 即是）無帳可守，閘門不啟動——不給任務路徑添加今天沒有的
// 故障面；日後 TTS 定價接入後把 baseBillingAmount 改為實際金額即自動受閘。
//
// env 未設/非 "1" = 原路徑一字不變（影子期雙模式並存，部署時才切流量）：
// 閘門直通返回原金額，連映射查詢與網關讀取都不發生。
//
// KEY 永不入 log：這裡只記 biz key id（非密鑰本體）、user id、token id 與金額。

import { fetchGatewayUser } from "@/lib/gateway-admin";
import { findNewApiTokenIdForBizKey } from "./biz-key-token-mapping";
import type { GenerationSql } from "./database";

export const SURGERY_QUOTA_PRECHECK_ENV = "SURGERY_QUOTA_PRECHECK";

/** 預檢讀數的硬上限（僅異常情況的天花板；同網單次 GET 常規個位數毫秒）。 */
export const QUOTA_PRECHECK_TIMEOUT_MS_DEFAULT = 3_000;

/** 既有契約文案：與 image-billing「余额不足」及 legacy 402 分支同款，一字不改。 */
const INSUFFICIENT_QUOTA_MESSAGE = "余额不足，请先充值。";

/** 既有契約體：images/videos durable 分支對控制面基底不可用的原樣碼。 */
const CONTROL_PLANE_UNAVAILABLE = {
  ok: false,
  status: 503,
  type: "api_error",
  code: "control_plane_unavailable",
  message: "Generation control plane is temporarily unavailable.",
} as const;

type GatewayUserReader = typeof fetchGatewayUser;

export type QuotaPrecheckVerdict =
  | { verdict: "available"; quota: number }
  | { verdict: "insufficient"; quota: number; requiredQuota: number }
  | { verdict: "unreachable"; reason: string };

export type QuotaGateDecision =
  | { ok: true; billingAmount: number }
  | {
      ok: false;
      status: 402 | 503;
      type: "insufficient_quota" | "api_error";
      code: "insufficient_quota" | "control_plane_unavailable";
      message: string;
    };

/** 手術開關：僅字面 "1" 生效（未設/"0"/其他值 = 原路徑）。 */
export function surgeryQuotaPrecheckEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SURGERY_QUOTA_PRECHECK_ENV]?.trim() === "1";
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * 無狀態配額三態預檢：一次只讀 GET /api/user/{id}（沿用 fetchGatewayUser），
 * 無執行器、無鎖、無本地狀態，不可能卡住任務路徑（超時即判不可達）。
 */
export async function checkQuotaAvailable(
  input: { billingUserId: number; requiredQuota: number },
  deps: { fetchUser?: GatewayUserReader; timeoutMs?: number } = {},
): Promise<QuotaPrecheckVerdict> {
  // user_id=0 是 007 遷移定義的「無從計費」應急通道，new-api 側不存在該用戶，
  // 直接判不可達（fail-closed），不發無謂請求。
  if (!Number.isInteger(input.billingUserId) || input.billingUserId <= 0) {
    return { verdict: "unreachable", reason: `no usable billing user (user_id=${input.billingUserId})` };
  }

  const fetchUser = deps.fetchUser ?? fetchGatewayUser;
  const timeoutMs = deps.timeoutMs ?? QUOTA_PRECHECK_TIMEOUT_MS_DEFAULT;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const user = await Promise.race([
      fetchUser(input.billingUserId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, timeoutMs);
      }),
    ]);
    if (!user || !Number.isFinite(user.quota)) {
      return {
        verdict: "unreachable",
        reason: timedOut
          ? `new-api quota read timed out after ${timeoutMs}ms`
          : "new-api user lookup failed or returned no quota",
      };
    }
    if (user.quota >= input.requiredQuota) {
      return { verdict: "available", quota: user.quota };
    }
    return { verdict: "insufficient", quota: user.quota, requiredQuota: input.requiredQuota };
  } catch (error) {
    return { verdict: "unreachable", reason: reasonOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 提交路徑計費閘：決定本次提交的金額（0 = 跳過阻塞式 reserve）或拒單。
 *
 * 返回 ok=true 時 billingAmount 交給 submitGenerationCommand——0 額任務由
 * job-repository 直送 queued；非 0 額 = 原路徑（reserve 執行器照舊）。
 * 返回 ok=false 時攜帶現契約錯誤碼，路由原樣轉成 OpenAI 風格錯誤體。
 */
export async function enforceQuotaGate(
  input: { bizKeyId: string; billingUserId: number; baseBillingAmount: number },
  deps: { fetchUser?: GatewayUserReader; sql?: GenerationSql; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<QuotaGateDecision> {
  const env = deps.env ?? process.env;
  if (!surgeryQuotaPrecheckEnabled(env) || input.baseBillingAmount <= 0) {
    return { ok: true, billingAmount: input.baseBillingAmount };
  }

  // 映射 fail-closed：沒有 token 映射的 key 不放進無配額執法的內核（012 承諾）。
  // sql 缺省時映射層自行按控制面開關降級（disabled → null → fail-closed）。
  const tokenId = await findNewApiTokenIdForBizKey(input.bizKeyId, deps.sql);
  if (tokenId === null) {
    console.error(
      `[quota-precheck] fail-closed: no new-api token mapping for biz key ${input.bizKeyId}; rejecting submission per migration 012 contract`,
    );
    return { ...CONTROL_PLANE_UNAVAILABLE };
  }

  const precheck = await checkQuotaAvailable(
    { billingUserId: input.billingUserId, requiredQuota: input.baseBillingAmount },
    { fetchUser: deps.fetchUser, timeoutMs: deps.timeoutMs },
  );

  if (precheck.verdict === "insufficient") {
    return {
      ok: false,
      status: 402,
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: INSUFFICIENT_QUOTA_MESSAGE,
    };
  }

  if (precheck.verdict === "unreachable") {
    // 不可達：沿用現有代碼對 new-api 不可用的既有姿勢——回落原 reserve 路徑，
    // 由 billing-ledger 按既有分類凍結/重試，閘門不發明新語義。
    console.error(
      `[quota-precheck] new-api unreachable for biz key ${input.bizKeyId} userId=${input.billingUserId}; falling back to incumbent reserve: ${precheck.reason}`,
    );
    return { ok: true, billingAmount: input.baseBillingAmount };
  }

  console.log(
    `[quota-precheck] pass bizKey=${input.bizKeyId} userId=${input.billingUserId} tokenId=${tokenId} quota=${precheck.quota} required=${input.baseBillingAmount}; skipping blocking reserve (billing -> post-hoc projection)`,
  );
  return { ok: true, billingAmount: 0 };
}
