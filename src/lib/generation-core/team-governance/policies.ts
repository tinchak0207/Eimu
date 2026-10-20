import { TEAM_ROLES, type TeamActor, type TeamRosterEntry, type TeamRole } from "./types";

export function resolveTeamActor(input: {
  userId: number;
  teamUserId: number;
  roster: Pick<TeamRosterEntry, "memberUserId" | "role">[];
}): TeamActor | null {
  if (input.userId === input.teamUserId) {
    return { userId: input.userId, teamUserId: input.teamUserId, role: "owner", isOwner: true, isMember: false };
  }
  const row = input.roster.find((entry) => entry.memberUserId === input.userId);
  if (!row) return null;
  return {
    userId: input.userId,
    teamUserId: input.teamUserId,
    role: row.role,
    isOwner: row.role === "owner",
    isMember: true,
  };
}

export function isTeamManager(role: TeamRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * 角色变更授权（纯函式）：
 *   owner → 可改他人（任何角色）；admin → 只能改「现角色为 member」的人，且不得指派 owner；
 *   member → 不可改任何人。
 */
export function canManageRole(
  actor: TeamActor,
  target: { role: TeamRole; memberUserId: number },
  nextRole: TeamRole,
): boolean {
  if (target.memberUserId === actor.teamUserId) return false; // 团队主帐恒 owner，不可被改
  if (actor.role === "owner") return true;
  if (actor.role === "admin") return target.role === "member" && nextRole !== "owner";
  return false;
}

/** 名册角色可写入性：owner 可指派任何角色；admin 不得制造新 owner（同上）。 */
export function assignableRoles(actor: TeamActor): TeamRole[] {
  if (actor.role === "owner") return [...TEAM_ROLES];
  if (actor.role === "admin") return ["admin", "member"];
  return [];
}

/** owner 集合大小 = 团队主帐(必为 owner) + 名册 owner。恒 ≥ 1。 */
export function ownerCount(teamUserId: number, roster: Pick<TeamRosterEntry, "role">[]): number {
  return 1 + roster.filter((entry) => entry.role === "owner").length;
}
// ── 建画布权限（团队级开关）

/** 成员不可建共享画布的文案（语义对齐竞品，风格用我方）。 */
export const TEAM_CANVAS_FORBIDDEN_MESSAGE =
  "只有团队创建者或管理员可以创建共享画布，请联系团队管理员开启「成员创建画布」权限。";
export const TEAM_CANVAS_FORBIDDEN_CODE = "member_canvas_forbidden";


/**
 * 纯函式判定：owner/admin 一律可建；member 需团队开关开启；非成员不受此闸。
 */
export function canCreateSharedCanvas(input: {
  actor: Pick<TeamActor, "role"> | null;
  memberCreateCanvas: boolean;
}): { allowed: boolean; code?: string; message: string } {
  if (!input.actor) return { allowed: true, message: "" };
  if (isTeamManager(input.actor.role)) return { allowed: true, message: "" };
  if (input.memberCreateCanvas) return { allowed: true, message: "" };
  return { allowed: false, code: TEAM_CANVAS_FORBIDDEN_CODE, message: TEAM_CANVAS_FORBIDDEN_MESSAGE };
}
// ── 资产面 RBAC（三级权限矩阵；与 canCreateSharedCanvas **并列**，不覆盖）

/**
 * 资产面权限矩阵（逐字对照 Dramagic Team/Asset 页；语义照做，命名用我方）。
 *
 * | 层级                     | view                | manage                              |
 * |--------------------------|---------------------|-------------------------------------|
 * | Main（Super Admin）      | 全帐号              | 全帐号（all global assets）          |
 * | Sub（Team Admin）        | 队内全部            | 队内全部（含他人建的）               |
 * | Sub（Member）            | 队内全部            | **只可管自己建的**                   |
 *
 * 帐号级（= 非团队资产 / 个人资产）维度：
 *   - 自己建的 → 可管（任何人管自己的资产恒真）。
 *   - 他人建的个人资产 → 任何人都不可管（跨帐号是硬边界，见 asset-scope
 *     resolveAssetVisibility 的「跨帐号：一律不可见（跨帐号是 RBAC 那一刀）」）。
 *
 * **fail-closed**：actor 为 null（查不到身份）或 actorUserId 不合法 → 拒。
 * 这与建画布闸的 fail-open **刻意不同**：建画布闸的 null 语义是「relay 挂了」，
 * 放行只是不挡创作；资产管理是**写别人的资料**，证明不了身份就不得放行。
 */
export const TEAM_ASSET_FORBIDDEN_CODE = "team_asset_forbidden";
export const TEAM_ASSET_FORBIDDEN_MESSAGE = "无权管理该资产：只有资产创建者或团队管理员可以修改团队资产。";

/** 资产面总开关：Main / Team Admin 恒真，Member 需资产属主。 */
export function canManageTeamAsset(input: {
  /** 判定主体的有效角色；null = 查不到身份（fail-closed → 拒）。 */
  actor: Pick<TeamActor, "role"> | null;
  /** 资产属主 user id（= 建该资产的帐号）。 */
  assetOwnerUserId: number | null;
  /** 当前操作者 user id。 */
  actorUserId: number | null;
}): { allowed: boolean; code?: string; message: string } {
  // fail-closed ①：身份不明 → 不得管任何资产。
  if (!input.actor) return { allowed: false, code: TEAM_ASSET_FORBIDDEN_CODE, message: TEAM_ASSET_FORBIDDEN_MESSAGE };
  if (
    typeof input.actorUserId !== "number" ||
    !Number.isInteger(input.actorUserId) ||
    input.actorUserId <= 0
  ) {
    return { allowed: false, code: TEAM_ASSET_FORBIDDEN_CODE, message: TEAM_ASSET_FORBIDDEN_MESSAGE };
  }
  // 自己的资产恒可管（含匿名资产：assetOwnerUserId 为 null 时**只有**自己建的视角成立；
  // 查不出属主的资产不得被当成「人人可管」——见 fail-closed ③）。
  if (input.assetOwnerUserId === input.actorUserId) return { allowed: true, message: "" };
  // owner（= Main，含团队主帐与共同所有者）与 admin（= Team Admin）：队内/全帐号全部资产。
  if (isTeamManager(input.actor.role)) return { allowed: true, message: "" };
  // fail-closed ③：member 且属主不明 → 拒（不把「查不出属主」读成「自己的」）。
  if (
    input.assetOwnerUserId === null ||
    typeof input.assetOwnerUserId !== "number" ||
    !Number.isInteger(input.assetOwnerUserId) ||
    input.assetOwnerUserId <= 0
  ) {
    return { allowed: false, code: TEAM_ASSET_FORBIDDEN_CODE, message: TEAM_ASSET_FORBIDDEN_MESSAGE };
  }
  // member：只可管自己建的（上面已排除相等情形）⇒ 他人资产一律拒。
  return { allowed: false, code: TEAM_ASSET_FORBIDDEN_CODE, message: TEAM_ASSET_FORBIDDEN_MESSAGE };
}

/** 资产面**读取**权：Main / Team Admin / Member 皆可读队内全部；非成员只可读自己的。 */
export function canViewTeamAsset(input: {
  actor: Pick<TeamActor, "role"> | null;
  assetOwnerUserId: number | null;
  actorUserId: number | null;
}): boolean {
  if (input.assetOwnerUserId === input.actorUserId && typeof input.actorUserId === "number") return true;
  if (!input.actor) return false; // fail-closed：身份不明 → 不可读他人资产
  // 队内任何角色皆可读队内资产（Dramagic：Member「Team assets view」）。
  return true;
}
export function dissolutionDueAt(scheduledAt: string | null): number | null {
  if (!scheduledAt) return null;
  const ms = new Date(scheduledAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}
