// 团队成员身份查询（Vercel → 控制面 relay）。
//
// 为什么需要它：画布路由由 Vercel 服务，而 Vercel 按设计不持有
// `GENERATION_DATABASE_URL`／`GENERATION_CONTROL_PLANE_ENABLED` ⇒ 治理层直连在这一侧
// 物理上不可用（`governanceStoreEnabled()===false` ⇒ 建画布闸永远走「未配置→放行」）。
// 治本＝控制面加一条**平台密钥可调用的唯读桥端点**，Vercel 经既有 HMAC 签名通道查
// 「某 user 属于哪个团队、role、成员建画布开关」。
//
// 轮子：逐行照抄 `src/lib/newapi-session-token.ts` 的 `ViaRelay` 模式
//（签名／headers／timeout／`GENERATION_CONTROL_PLANE_PROXY_ORIGIN` 取值／错误吞噬
// 语义全部相同），只换路径与 signatureDomain（域分隔，防跨端点重放）。
//
// 契约（orchestrator 钉死；控制面侧由另一片实作）：
//   GET  <GENERATION_CONTROL_PLANE_PROXY_ORIGIN>/image-control/api/internal/team-membership?user_id=<整数>
//   签名：signBizKeySync(secret, timestamp, rawBody, "team-membership")
//         headers 逐字 X-Biz-Key-Sync-Timestamp / X-Biz-Key-Sync-Signature
//   密钥：env GENERATION_BILLING_RELAY_SECRET
//   GET 无 body ⇒ rawBody = ""（控制面侧以 req.text() 取原文验签，同值）。
//   成功：200 { ok: true, membership: TeamMembership | null }
//
// fail-open：未配置 env／逾时／非 200／签名失败／JSON 不合法／栏位不合法 → 一律 null，
// **禁丢例外**（呼叫端据 null 走「查不到 → 放行」，控制面一挂不得让全站建不了画布）。

import { signBizKeySync } from "@/lib/biz-key-sync";

const RELAY_TIMEOUT_MS = 15_000;

const RELAY_SIGNATURE_DOMAIN = "team-membership";

/** 团队角色（与控制面 team_member_quota.role 同值域）。 */
export type TeamMembershipRole = "owner" | "admin" | "member";

/** 控制面回传的成员身份（单一真源；画布闸只吃这个形）。 */
export interface TeamMembership {
  /** 团队主帐 id（＝控制面 team_member_quota.team_user_id）。 */
  teamId: string;
  /** 被查的成员 id（整数）。 */
  userId: number;
  role: TeamMembershipRole;
  /** 团队设定：成员可否建共享画布。 */
  memberCreateCanvas: boolean;
  /** 团队席位数（意图整数，计价未接）。 */
  seats: number;
}

function isRole(value: unknown): value is TeamMembershipRole {
  return value === "owner" || value === "admin" || value === "member";
}

/**
 * 反序列化清洗（载荷不可信，逐栏白名单）：任何一栏不合法 → null
 *（＝「查不到」→ 呼叫端放行，不因坏载荷误拒）。
 */
function normalizeMembership(payload: unknown): TeamMembership | null {
  if (!payload || typeof payload !== "object") return null;
  const m = payload as Record<string, unknown>;
  // teamId 契约是 string；控制面若回数字整数则正规化（防两侧型别漂移直接静默哑火）。
  const teamId =
    typeof m.teamId === "string" && m.teamId.trim().length > 0
      ? m.teamId.trim()
      : typeof m.teamId === "number" && Number.isInteger(m.teamId) && m.teamId > 0
        ? String(m.teamId)
        : null;
  if (!teamId) return null;
  if (typeof m.userId !== "number" || !Number.isInteger(m.userId) || m.userId <= 0) return null;
  if (!isRole(m.role)) return null;
  if (typeof m.memberCreateCanvas !== "boolean") return null;
  if (typeof m.seats !== "number" || !Number.isFinite(m.seats)) return null;
  return {
    teamId,
    userId: m.userId,
    role: m.role,
    memberCreateCanvas: m.memberCreateCanvas,
    seats: m.seats,
  };
}

/**
 * Vercel 侧：经 HMAC 签名通道查该 user 的团队成员身份。
 * env 缺一或任何失败 → null（呼叫端据此放行，维持既有兜底语义）。
 */
export async function lookupTeamMembershipViaRelay(userId: number): Promise<TeamMembership | null> {
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) return null;
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return null;
  try {
    // GET 无 body：签名原文＝空字串（与控制面侧 req.text() 取到的原文同值）。
    const rawBody = "";
    const timestamp = String(Date.now());
    const signature = signBizKeySync(secret, timestamp, rawBody, RELAY_SIGNATURE_DOMAIN);
    const res = await fetch(
      `${origin}/image-control/api/internal/team-membership?user_id=${encodeURIComponent(String(userId))}`,
      {
        method: "GET",
        headers: {
          "X-Biz-Key-Sync-Timestamp": timestamp,
          "X-Biz-Key-Sync-Signature": signature,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | ({ ok?: boolean; membership?: unknown })
      | null;
    if (!data?.ok) return null;
    return normalizeMembership(data.membership);
  } catch (error) {
    console.error("[team-membership] relay failed", error);
    return null;
  }
}
