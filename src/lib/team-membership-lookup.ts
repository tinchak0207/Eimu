// 團隊成員身份查詢（Vercel → 控制面 relay）。
//
// 為什麼需要它：畫布路由由 Vercel 服務，而 Vercel 按設計不持有
// `GENERATION_DATABASE_URL`／`GENERATION_CONTROL_PLANE_ENABLED` ⇒ 治理層直連在這一側
// 物理上不可用（`governanceStoreEnabled()===false` ⇒ 建畫布閘永遠走「未配置→放行」）。
// 治本＝控制面加一條**平台密鑰可調用的唯讀橋端點**，Vercel 經既有 HMAC 簽名通道查
// 「某 user 屬於哪個團隊、role、成員建畫布開關」。
//
// 輪子：逐行照抄 `src/lib/newapi-session-token.ts` 的 `ViaRelay` 模式
//（簽名／headers／timeout／`GENERATION_CONTROL_PLANE_PROXY_ORIGIN` 取值／錯誤吞噬
// 語義全部相同），只換路徑與 signatureDomain（域分隔，防跨端點重放）。
//
// 契約（orchestrator 釘死；控制面側由另一片實作）：
//   GET  <GENERATION_CONTROL_PLANE_PROXY_ORIGIN>/image-control/api/internal/team-membership?user_id=<整數>
//   簽名：signBizKeySync(secret, timestamp, rawBody, "team-membership")
//         headers 逐字 X-Biz-Key-Sync-Timestamp / X-Biz-Key-Sync-Signature
//   密鑰：env GENERATION_BILLING_RELAY_SECRET
//   GET 無 body ⇒ rawBody = ""（控制面側以 req.text() 取原文驗簽，同值）。
//   成功：200 { ok: true, membership: TeamMembership | null }
//
// fail-open：未配置 env／逾時／非 200／簽名失敗／JSON 不合法／欄位不合法 → 一律 null，
// **禁丟例外**（呼叫端據 null 走「查不到 → 放行」，控制面一掛不得讓全站建不了畫布）。

import { signBizKeySync } from "@/lib/biz-key-sync";

const RELAY_TIMEOUT_MS = 15_000;

const RELAY_SIGNATURE_DOMAIN = "team-membership";

/** 團隊角色（與控制面 team_member_quota.role 同值域）。 */
export type TeamMembershipRole = "owner" | "admin" | "member";

/** 控制面回傳的成員身份（單一真源；畫布閘只吃這個形）。 */
export interface TeamMembership {
  /** 團隊主帳 id（＝控制面 team_member_quota.team_user_id）。 */
  teamId: string;
  /** 被查的成員 id（整數）。 */
  userId: number;
  role: TeamMembershipRole;
  /** 團隊設定：成員可否建共享畫布。 */
  memberCreateCanvas: boolean;
  /** 團隊席位數（意圖整數，計價未接）。 */
  seats: number;
}

function isRole(value: unknown): value is TeamMembershipRole {
  return value === "owner" || value === "admin" || value === "member";
}

/**
 * 反序列化清洗（載荷不可信，逐欄白名單）：任何一欄不合法 → null
 *（＝「查不到」→ 呼叫端放行，不因壞載荷誤拒）。
 */
function normalizeMembership(payload: unknown): TeamMembership | null {
  if (!payload || typeof payload !== "object") return null;
  const m = payload as Record<string, unknown>;
  // teamId 契約是 string；控制面若回數字整數則正規化（防兩側型別漂移直接靜默啞火）。
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
 * Vercel 側：經 HMAC 簽名通道查該 user 的團隊成員身份。
 * env 缺一或任何失敗 → null（呼叫端據此放行，維持既有兜底語義）。
 */
export async function lookupTeamMembershipViaRelay(userId: number): Promise<TeamMembership | null> {
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) return null;
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return null;
  try {
    // GET 無 body：簽名原文＝空字串（與控制面側 req.text() 取到的原文同值）。
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
