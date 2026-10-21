// 团队治理六面（席位／角色／建画布权限／加入审批／生命周期／用量）。
//
// 定性：**在既有团队真源上长**，不新建第二套团队模型（见 db/migrations/023）。
//   团队身份 = team_user_id（= 团队主 B key 的 biz_api_key.user_id = new-api users.id）
//   成员名册 = team_member_quota（019）＋ role 栏（023）
//   配额真源 = new-api（users.quota）；本模组**不碰任何点数数字**，
//   也**不呼叫任何上游额度调整**——分配/回收唯一通路是 member-quota.ts（禁影子帐本）。
//
// 分工：
//   - member-quota.ts：配额映射与转移（唯一权威）。本模组不重写它，只读名册与配额可视面。
//   - account-ledger.ts：用量统计的逐笔来源（读既有帐本，不新建统计帐本）。
//   - 本模组：身份与意图（role / member_create_canvas / seats / 申请四态 / 解散冷静期）。
//
// 角色模型（与 member-quota 的 user 层模型一致）：
//   ★ 团队主帐 team_user_id 恒为 owner，且不入名册（019 CHECK 禁止 member 名册含主帐）。
//   ★ 名册 role = owner（共同所有者）/ admin / member；owner 集合恒非空
//     ⇒ 「移除/降级团队主帐」被 409 last_owner 拒（最后一个 owner 保护）。
//
// 不变量：
//   ① 不可移除/降级最后一个 owner（团队主帐不可被移除、不可 leave）。
//   ② min_members ≤ 名册成员数 ≤ seats ≤ max_members(硬上限)；满员时申请不得通过。
//   ③ 48h 解散冷静期内可撤回；冷静期过后不可撤回，执行才生效且幂等。
//   ④ 所有写入幂等：重放同请求不产生第二次副作用、不重复登记、不重复扣费。
//   ⑤ 审批/角色/席位/解散全路径不触碰点数（无上游调整呼叫）⇒ 无影子帐本、无重复扣费。

export {
  HOUR_MS,
  JOIN_REQUEST_STATUSES,
  TEAM_CAPACITY_ENV,
  TEAM_DEFAULT_MAX_MEMBERS_DEFAULT,
  TEAM_DISSOLVE_COOLOFF_HOURS_DEFAULT,
  TEAM_MAX_JOINED_TEAMS_DEFAULT,
  TEAM_MAX_MEMBERS_DEFAULT,
  TEAM_MAX_OWNED_TEAMS_DEFAULT,
  TEAM_MIN_MEMBERS_DEFAULT,
  TEAM_ROLES,
  isTeamRole,
  teamCapacity,
  teamDissolveCooloffMs,
  teamJoinLimits,
} from "./team-governance/types";
export type {
  CanvasPermission,
  GovernanceCode,
  GovernanceFailure,
  GovernanceResult,
  JoinRequestStatus,
  TeamActor,
  TeamCapacity,
  TeamGovernanceDeps,
  TeamJoinLimits,
  TeamJoinRequestRecord,
  TeamLifecycle,
  TeamMemberUsage,
  TeamRole,
  TeamRosterEntry,
  TeamSettingsRecord,
  TeamUsageRecord,
  TeamUsageSummary,
} from "./team-governance/types";

export {
  TEAM_ASSET_FORBIDDEN_CODE,
  TEAM_ASSET_FORBIDDEN_MESSAGE,
  TEAM_CANVAS_FORBIDDEN_CODE,
  TEAM_CANVAS_FORBIDDEN_MESSAGE,
  assignableRoles,
  canCreateSharedCanvas,
  canManageRole,
  canManageTeamAsset,
  canViewTeamAsset,
  dissolutionDueAt,
  isTeamManager,
  ownerCount,
  resolveTeamActor,
} from "./team-governance/policies";

export {
  countJoinedTeams,
  countOwnedTeams,
  defaultTeamSettings,
  findRosterEntryByUserId,
  listTeamRoster,
  readTeamSettings,
  resolveActorTeam,
} from "./team-governance/store";

export { canMemberCreateSharedCanvas, setMemberRole, setTeamSeats, updateTeamSettings } from "./team-governance/roles";

export { applyToJoinTeam, decideJoinRequest, listJoinRequests } from "./team-governance/joins";

export {
  executeTeamDissolution,
  getTeamLifecycle,
  leaveTeam,
  removeTeamMember,
  scheduleTeamDissolution,
  withdrawTeamDissolution,
} from "./team-governance/lifecycle";

export { readTeamUsage } from "./team-governance/usage";
export type { TeamLedgerReader } from "./team-governance/usage";
