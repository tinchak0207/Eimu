// /api/assets 的團隊閘（P0-2 資產團隊維度，寫入端）——自 route.ts 移出：
// Next.js 的 route 模組只准匯出 HTTP handler 與路由設定，多匯出任何名字 build 即失敗。

import { lookupTeamMembershipViaRelay, type TeamMembership } from "@/lib/team-membership-lookup";

/** 團隊閘的成員查詢簽名（測試可注入；缺省＝真實 relay）。 */
export interface AssetsTeamGateDeps {
  membership?: (userId: number) => Promise<TeamMembership | null>;
}

/**
 * 團隊閘的注入點（**測試用**）：route handler 的簽名由 Next.js 的
 * `.next/types/validator` 釘死，第二參數必須是 `{ params: Promise<{}> }`，
 * 故不能把 deps 塞進簽名。改為模組層可覆寫（測試設、測完還原）。
 * 生產路徑下恆為 undefined → 走真實 relay 查詢。
 */
let teamGateDeps: AssetsTeamGateDeps = {};

/** 生產路徑：未注入時走真實 relay 查成員身份。 */
export function lookupAssetsTeamMembership(userId: number): Promise<TeamMembership | null> {
  return teamGateDeps.membership ? teamGateDeps.membership(userId) : lookupTeamMembershipViaRelay(userId);
}

/** 僅測試：覆寫團隊閘的成員查詢（傳 undefined 還原真實 relay）。 */
export function __setAssetsTeamGateDepsForTests(deps?: AssetsTeamGateDeps): void {
  teamGateDeps = deps ?? {};
}

/**
 * team 作用域的寫入端裁決（純函式，資料源＝relay 的 membership）。
 *
 * 回 `{ ok: true, scope }`：
 *  - 非 team 宣告 → 原樣（personal / project 完全不走這裡的團隊邏輯）
 *  - team 宣告 + relay 權威 teamId 且（客戶端沒送 teamId 或送的與權威值相符）→ team 作用域，teamId ＝ **權威值**
 * 回 `{ ok: false }`：宣告 team 但 teamId 對不上權威值 → 呼叫端**降級個人**（fail-open，
 * 不拒、不寫進別人的團隊；與畫布閘同語義）。
 */
export function decideTeamAssetScope(input: {
  declaredTeamId: unknown;
  membership: TeamMembership | null;
}): { ok: true; scope: { owner: "team"; teamId: string } } | { ok: false } {
  const authoritativeTeamId =
    input.membership && typeof input.membership.teamId === "string" ? input.membership.teamId.trim() : "";
  if (!authoritativeTeamId) return { ok: false };
  const declared =
    typeof input.declaredTeamId === "string" && input.declaredTeamId.trim() ? input.declaredTeamId.trim() : null;
  if (declared && declared !== authoritativeTeamId) return { ok: false };
  return { ok: true, scope: { owner: "team", teamId: authoritativeTeamId } };
}
