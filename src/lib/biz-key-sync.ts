// admin（Vercel）→ control plane（VPS）的密钥写入通道。
//
// 为什么需要它：权威源是 control plane 的 Postgres，但那个库没有对外发布端口，
// Vercel 上的 admin 路由连不上。而 control plane 上没有 ADMIN_SESSION_SECRET，
// 所以也不能简单地把 /api/admin/biz-keys 重写过去 —— 那边 requireAdminSession()
// 会直接 401。（同样的原因，现有的 billing-operations 重写在控制面侧也是 401 的。）
//
// Vercel 的 ADMIN_SESSION_SECRET 被标记为 sensitive，连 CLI 都读不回来，
// 只能覆盖。与其重置它（会踢掉所有在线管理员会话），不如复用两侧都已经有的
// GENERATION_BILLING_RELAY_SECRET 做 HMAC —— 不新增任何环境变量。
//
// 签名载荷带上 "biz-key-sync" 前缀做域分隔：同一把密钥在计费中继上是
// 「控制面 → Vercel 扣费」，在这里是「Vercel → 控制面写密钥」，
// 两个方向的报文不能互相重放。
// 其他内部只读端点可复用这条签名通道，但必须传入自己的域前缀
// （signBizKeySync 的 signatureDomain 参数），不得沿用 "biz-key-sync"。

import { createHmac, timingSafeEqual } from "node:crypto";
import type { BizApiKey } from "./biz-api-keys";

export const BIZ_KEY_SYNC_TIMESTAMP_HEADER = "X-Biz-Key-Sync-Timestamp";
export const BIZ_KEY_SYNC_SIGNATURE_HEADER = "X-Biz-Key-Sync-Signature";

/** 域分隔前缀。改动它等于让新旧两侧签名互不认，属于破坏性变更。 */
const SIGNATURE_DOMAIN = "biz-key-sync";

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type BizKeySyncOperation =
  | { op: "list" }
  | { op: "insert"; record: BizApiKey }
  | { op: "update"; id: string; patch: Partial<Pick<BizApiKey, "label" | "enabled" | "rpm" | "allowedModels" | "userId">> }
  | { op: "delete"; id: string }
  // 诊断只读，走同一条签名通道：控制面上没有 ADMIN_SESSION_SECRET，
  // 校验不了管理员会话，而 Postgres 只在那一侧。
  | { op: "diagnostics" };

function hmac(secret: string, timestamp: string, rawBody: string, signatureDomain: string = SIGNATURE_DOMAIN): string {
  return createHmac("sha256", secret).update(`${signatureDomain}.${timestamp}.${rawBody}`).digest("hex");
}

export function signBizKeySync(
  secret: string,
  timestamp: string,
  rawBody: string,
  signatureDomain: string = SIGNATURE_DOMAIN,
): string {
  return `sha256=${hmac(secret, timestamp, rawBody, signatureDomain)}`;
}

export function verifyBizKeySync(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: number;
  /** 域分隔前缀，默认 "biz-key-sync"。其他内部端点复用通道时必须传自己的前缀。 */
  signatureDomain?: string;
}): boolean {
  if (!input.timestamp || !input.signature || !input.secret) return false;
  const timestampMs = Number(input.timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs((input.now ?? Date.now()) - timestampMs) > MAX_CLOCK_SKEW_MS) return false;
  const expected = signBizKeySync(input.secret, input.timestamp, input.rawBody, input.signatureDomain ?? SIGNATURE_DOMAIN);
  const actual = Buffer.from(input.signature);
  const expectedBytes = Buffer.from(expected);
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

/**
 * 出站配置。
 *
 * 复用 GENERATION_CONTROL_PLANE_PROXY_ORIGIN（Vercel 上已配置，指向控制面）
 * 与 GENERATION_BILLING_RELAY_SECRET（两侧都有）。
 * 缺任何一个就返回 null，调用方退回本地 Blob 路径。
 */
export function bizKeySyncConfig(env: NodeJS.ProcessEnv = process.env): { url: string; secret: string } | null {
  const origin = env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/$/, "");
  const secret = env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return null;
  return { url: `${origin}/image-control/api/internal/biz-keys`, secret };
}

export class BizKeySyncError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BizKeySyncError";
    this.status = status;
  }
}

/** 调一次控制面。返回值形状由 op 决定：list → BizApiKey[]，其余 → 受影响记录或 null。 */
export async function invokeBizKeySync(
  operation: BizKeySyncOperation,
  config: { url: string; secret: string },
): Promise<unknown> {
  const rawBody = JSON.stringify(operation);
  const timestamp = String(Date.now());

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [BIZ_KEY_SYNC_TIMESTAMP_HEADER]: timestamp,
      [BIZ_KEY_SYNC_SIGNATURE_HEADER]: signBizKeySync(config.secret, timestamp, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(20_000),
  });

  const payload = await response.json().catch(() => null) as { ok?: boolean; data?: unknown; message?: string } | null;
  if (!response.ok || !payload?.ok) {
    throw new BizKeySyncError(payload?.message ?? `密钥同步失败（HTTP ${response.status}）。`, response.status);
  }
  return payload.data ?? null;
}
