// 团队画布闸（片F 面 2 接线 → 2026-09-27 片P 刀 3 换真资料源）。
//
// 真源：全站**唯一**的画布建立/落盘入口是 `PUT /api/canvas/projects`
// （`saveCanvasProject` upsert by id；前端所有建立路径——工具箱「新建画布」、
// 模板铺画布、agent 下发节点后 debounce 存档——最终都收敛到这条 PUT）。
// 因此闸设在这里，而不是各前端入口——否则新入口一加就漏。
//
// 资料源（刀 3）：`lookupTeamMembershipViaRelay`（Vercel → 控制面签名通道）。
// 片K 的旧源是控制面直连（`canMemberCreateSharedCanvas` 读 PG），但 Vercel 按设计
// 不持有 `GENERATION_DATABASE_URL` ⇒ `governanceStoreEnabled()===false` ⇒ 闸恒走
// 「未配置→放行」，等于没接上。改经 relay 后 Vercel 才真的查得到团队。
//
// 判定（与 team-governance.canCreateSharedCanvas 逐字对齐，不另立判断）：
//   ★ relay 回 null（未配置／逾时／查不到／载荷不合法）→ 放行（fail-open 兜底）。
//   ★ 非团队成员（个人帐号）→ 不受此闸，一律放行。
//   ★ owner / admin（含团队主帐）→ 恒放行。
//   ★ 成员（role=member）→ 依团队设定 member_create_canvas：开启放行，关闭拒绝。
//
// 「不得产生半成品专案」：先判后存——拒绝时**不呼叫** save*，专案数维持不变。
// 既有的「更新」不是「建」：已存在的专案 id 不受事后关闸影响
//（否则团队一关开关，成员手上既有画布会存不进去，等于资料损失）。
//
// 作用域（刀 1/刀 2）：`project.scope === "team"` 且已验成员身份 → 落团队命名空间
// `canvas/team/<teamId>`（teamId **以 relay 回传的权威值盖章**，客户端送来的不采信）；
// 查不到成员身份 → 降级个人命名空间（fail-open，不拒、不写进别人的团队）。
// 团队画布单写（后写覆盖），刻意不做锁／CRDT／冲突解决。
//
// 本模组只读成员身份与画布 store，不碰任何点数/计费（禁影子帐本）。

import {
  TEAM_CANVAS_FORBIDDEN_CODE,
  TEAM_CANVAS_FORBIDDEN_MESSAGE,
} from "@/lib/generation-core/team-governance";
import { lookupTeamMembershipViaRelay, type TeamMembership } from "@/lib/team-membership-lookup";

import {
  listCanvasProjects,
  listTeamCanvasProjects,
  readCanvasProject,
  readTeamCanvasProject,
  saveCanvasProject,
  saveTeamCanvasProject,
} from "./project-store";
import type { CanvasProject } from "./types";

export interface TeamCanvasGateDeps {
  /** 测试注入点：缺省＝真实 relay 查询 lookupTeamMembershipViaRelay()。 */
  membership?: (userId: number) => Promise<TeamMembership | null>;
}

export interface TeamCanvasGateDenied {
  ok: false;
  status: 403;
  code: string;
  message: string;
}

/**
 * 成员建画布裁决（纯函式，资料源＝membership）。
 * null（查不到／fail-open）与非 member 一律放行；member 依开关。
 */
function decide(membership: TeamMembership | null): { allowed: boolean; code?: string; message?: string } {
  if (!membership) return { allowed: true };
  if (membership.role !== "member") return { allowed: true };
  if (membership.memberCreateCanvas) return { allowed: true };
  return { allowed: false, code: TEAM_CANVAS_FORBIDDEN_CODE, message: TEAM_CANVAS_FORBIDDEN_MESSAGE };
}

async function lookupMembership(
  userId: number,
  deps: TeamCanvasGateDeps,
): Promise<TeamMembership | null> {
  return deps.membership ? deps.membership(userId) : lookupTeamMembershipViaRelay(userId);
}

/** 写团队命名空间时**剥掉** scope/teamId（降级个人用；teamId 由委派决定）。 */
function asPersonal(project: CanvasProject): CanvasProject {
  const { scope: _scope, teamId: _teamId, ...rest } = project;
  return rest;
}

/**
 * 带团队闸的画布落盘：先判权限，拒绝则不写（无半成品）；放行后才落对应命名空间。
 *
 * 回传 `{ ok: true }` ＝已落盘；`{ ok: false, ... }` ＝被团队闸拒（呼叫端原样转 403）。
 */
export async function saveCanvasProjectWithTeamGate(
  userId: number,
  project: CanvasProject,
  deps: TeamCanvasGateDeps = {},
): Promise<{ ok: true } | TeamCanvasGateDenied> {
  const membership = await lookupMembership(userId, deps);
  const authoritativeTeamId = membership?.teamId ?? null;

  // 宣告 team 作用域但送的 teamId 与权威值不符 → 拒（不得写进别人的团队）；
  // 查不到成员身份（fail-open）不在此列——走降级个人，不拒。
  if (
    project.scope === "team" &&
    authoritativeTeamId &&
    typeof project.teamId === "string" &&
    project.teamId.trim().length > 0 &&
    project.teamId.trim() !== authoritativeTeamId
  ) {
    return { ok: false, status: 403, code: TEAM_CANVAS_FORBIDDEN_CODE, message: TEAM_CANVAS_FORBIDDEN_MESSAGE };
  }

  const teamId = project.scope === "team" ? authoritativeTeamId : null;

  const decision = decide(membership);
  if (!decision.allowed) {
    // 只有「建新画布」受闸；既有专案（更新/自动存档）不受事后关闸影响。
    const existing =
      teamId !== null
        ? await readTeamCanvasProject(teamId, project.id)
        : await readCanvasProject(userId, project.id);
    if (!existing) {
      return {
        ok: false,
        status: 403,
        code: decision.code ?? TEAM_CANVAS_FORBIDDEN_CODE,
        message: decision.message ?? TEAM_CANVAS_FORBIDDEN_MESSAGE,
      };
    }
  }

  if (teamId !== null) {
    await saveTeamCanvasProject(teamId, { ...project, scope: "team", teamId });
  } else {
    await saveCanvasProject(userId, asPersonal(project));
  }
  return { ok: true };
}

// ─────────────────────────────────────────── 读路径（刀 2：我个人的 + 我所属团队的）

function sortByUpdatedDesc(projects: CanvasProject[]): CanvasProject[] {
  return [...projects].sort((a, b) => {
    const at = Date.parse(a.updatedAt);
    const bt = Date.parse(b.updatedAt);
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
}

/**
 * 呼叫端可见的画布清单＝**我个人的 + 我所属团队的**（同 id 取新的）。
 *
 * fail-open：relay 查不到成员身份（未配置／挂掉）→ 只回个人（**不 500、不 403**），
 * 个人画布读取零影响。
 */
export async function listCanvasProjectsForCaller(
  userId: number,
  deps: TeamCanvasGateDeps = {},
): Promise<CanvasProject[]> {
  const personal = await listCanvasProjects(userId);
  const membership = await lookupMembership(userId, deps);
  if (!membership) return sortByUpdatedDesc(personal);
  const team = await listTeamCanvasProjects(membership.teamId).catch(() => [] as CanvasProject[]);
  const byId = new Map<string, CanvasProject>();
  for (const project of [...personal, ...team]) {
    const previous = byId.get(project.id);
    if (!previous) {
      byId.set(project.id, project);
      continue;
    }
    const next = Date.parse(project.updatedAt);
    const prev = Date.parse(previous.updatedAt);
    if ((Number.isFinite(next) ? next : 0) > (Number.isFinite(prev) ? prev : 0)) byId.set(project.id, project);
  }
  return sortByUpdatedDesc([...byId.values()]);
}

/**
 * 呼叫端**显式**读某团队的画布（`GET /api/canvas/projects?teamId=…`）。
 *
 * 这边是**拒**而不是放行：读团队命名空间＝碰别人的资料，必须先证明成员身份
 *（relay 回 null ⇒ 证明不了 ⇒ 403，与建画布闸同码同文案）。
 * 这不是 fail-closed 的回归——建画布/个人画布路径仍是 fail-open（见上），
 * 且查不到成员身份时唯一无法做的只有「读别团的画布」，不影响任何既有功能。
 */
export async function readTeamCanvasProjectsForCaller(
  userId: number,
  teamId: string,
  deps: TeamCanvasGateDeps = {},
): Promise<{ ok: true; projects: CanvasProject[] } | TeamCanvasGateDenied> {
  const membership = await lookupMembership(userId, deps);
  if (!membership || membership.teamId !== teamId) {
    return { ok: false, status: 403, code: TEAM_CANVAS_FORBIDDEN_CODE, message: TEAM_CANVAS_FORBIDDEN_MESSAGE };
  }
  const projects = await listTeamCanvasProjects(teamId).catch(() => [] as CanvasProject[]);
  return { ok: true, projects: sortByUpdatedDesc(projects) };
}
