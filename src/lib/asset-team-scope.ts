// /api/assets 的团队闸（P0-2 资产团队维度，写入端）——自 route.ts 移出：
// Next.js 的 route 模组只准汇出 HTTP handler 与路由设定，多汇出任何名字 build 即失败。

import { lookupTeamMembershipViaRelay, type TeamMembership } from "@/lib/team-membership-lookup";

/** 团队闸的成员查询签名（测试可注入；缺省＝真实 relay）。 */
export interface AssetsTeamGateDeps {
  membership?: (userId: number) => Promise<TeamMembership | null>;
}

/**
 * 团队闸的注入点（**测试用**）：route handler 的签名由 Next.js 的
 * `.next/types/validator` 钉死，第二参数必须是 `{ params: Promise<{}> }`，
 * 故不能把 deps 塞进签名。改为模组层可覆写（测试设、测完还原）。
 * 生产路径下恒为 undefined → 走真实 relay 查询。
 */
let teamGateDeps: AssetsTeamGateDeps = {};

/** 生产路径：未注入时走真实 relay 查成员身份。 */
export function lookupAssetsTeamMembership(userId: number): Promise<TeamMembership | null> {
  return teamGateDeps.membership ? teamGateDeps.membership(userId) : lookupTeamMembershipViaRelay(userId);
}

/** 仅测试：覆写团队闸的成员查询（传 undefined 还原真实 relay）。 */
export function __setAssetsTeamGateDepsForTests(deps?: AssetsTeamGateDeps): void {
  teamGateDeps = deps ?? {};
}

/**
 * team 作用域的写入端裁决（纯函式，资料源＝relay 的 membership）。
 *
 * 回 `{ ok: true, scope }`：
 *  - 非 team 宣告 → 原样（personal / project 完全不走这里的团队逻辑）
 *  - team 宣告 + relay 权威 teamId 且（客户端没送 teamId 或送的与权威值相符）→ team 作用域，teamId ＝ **权威值**
 * 回 `{ ok: false }`：宣告 team 但 teamId 对不上权威值 → 呼叫端**降级个人**（fail-open，
 * 不拒、不写进别人的团队；与画布闸同语义）。
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
