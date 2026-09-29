// 團隊畫布閘（片F 面 2 接線 → 2026-09-27 片P 刀 3 換真資料源）。
//
// 真源：全站**唯一**的畫布建立/落盤入口是 `PUT /api/canvas/projects`
// （`saveCanvasProject` upsert by id；前端所有建立路徑——工具箱「新建画布」、
// 模板鋪畫布、agent 下發節點後 debounce 存檔——最終都收斂到這條 PUT）。
// 因此閘設在這裡，而不是各前端入口——否則新入口一加就漏。
//
// 資料源（刀 3）：`lookupTeamMembershipViaRelay`（Vercel → 控制面簽名通道）。
// 片K 的舊源是控制面直連（`canMemberCreateSharedCanvas` 讀 PG），但 Vercel 按設計
// 不持有 `GENERATION_DATABASE_URL` ⇒ `governanceStoreEnabled()===false` ⇒ 閘恆走
// 「未配置→放行」，等於沒接上。改經 relay 後 Vercel 才真的查得到團隊。
//
// 判定（與 team-governance.canCreateSharedCanvas 逐字對齊，不另立判斷）：
//   ★ relay 回 null（未配置／逾時／查不到／載荷不合法）→ 放行（fail-open 兜底）。
//   ★ 非團隊成員（個人帳號）→ 不受此閘，一律放行。
//   ★ owner / admin（含團隊主帳）→ 恆放行。
//   ★ 成員（role=member）→ 依團隊設定 member_create_canvas：開啟放行，關閉拒絕。
//
// 「不得產生半成品專案」：先判後存——拒絕時**不呼叫** save*，專案數維持不變。
// 既有的「更新」不是「建」：已存在的專案 id 不受事後關閘影響
//（否則團隊一關開關，成員手上既有畫布會存不進去，等於資料損失）。
//
// 作用域（刀 1/刀 2）：`project.scope === "team"` 且已驗成員身份 → 落團隊命名空間
// `canvas/team/<teamId>`（teamId **以 relay 回傳的權威值蓋章**，客戶端送來的不採信）；
// 查不到成員身份 → 降級個人命名空間（fail-open，不拒、不寫進別人的團隊）。
// 團隊畫布單寫（後寫覆蓋），刻意不做鎖／CRDT／衝突解決。
//
// 本模組只讀成員身份與畫布 store，不碰任何點數/計費（禁影子帳本）。

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
  /** 測試注入點：缺省＝真實 relay 查詢 lookupTeamMembershipViaRelay()。 */
  membership?: (userId: number) => Promise<TeamMembership | null>;
}

export interface TeamCanvasGateDenied {
  ok: false;
  status: 403;
  code: string;
  message: string;
}

/**
 * 成員建畫布裁決（純函式，資料源＝membership）。
 * null（查不到／fail-open）與非 member 一律放行；member 依開關。
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

/** 寫團隊命名空間時**剝掉** scope/teamId（降級個人用；teamId 由委派決定）。 */
function asPersonal(project: CanvasProject): CanvasProject {
  const { scope: _scope, teamId: _teamId, ...rest } = project;
  return rest;
}

/**
 * 帶團隊閘的畫布落盤：先判權限，拒絕則不寫（無半成品）；放行後才落對應命名空間。
 *
 * 回傳 `{ ok: true }` ＝已落盤；`{ ok: false, ... }` ＝被團隊閘拒（呼叫端原樣轉 403）。
 */
export async function saveCanvasProjectWithTeamGate(
  userId: number,
  project: CanvasProject,
  deps: TeamCanvasGateDeps = {},
): Promise<{ ok: true } | TeamCanvasGateDenied> {
  const membership = await lookupMembership(userId, deps);
  const authoritativeTeamId = membership?.teamId ?? null;

  // 宣告 team 作用域但送的 teamId 與權威值不符 → 拒（不得寫進別人的團隊）；
  // 查不到成員身份（fail-open）不在此列——走降級個人，不拒。
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
    // 只有「建新畫布」受閘；既有專案（更新/自動存檔）不受事後關閘影響。
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

// ─────────────────────────────────────────── 讀路徑（刀 2：我個人的 + 我所屬團隊的）

function sortByUpdatedDesc(projects: CanvasProject[]): CanvasProject[] {
  return [...projects].sort((a, b) => {
    const at = Date.parse(a.updatedAt);
    const bt = Date.parse(b.updatedAt);
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
}

/**
 * 呼叫端可見的畫布清單＝**我個人的 + 我所屬團隊的**（同 id 取新的）。
 *
 * fail-open：relay 查不到成員身份（未配置／掛掉）→ 只回個人（**不 500、不 403**），
 * 個人畫布讀取零影響。
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
 * 呼叫端**顯式**讀某團隊的畫布（`GET /api/canvas/projects?teamId=…`）。
 *
 * 這邊是**拒**而不是放行：讀團隊命名空間＝碰別人的資料，必須先證明成員身份
 *（relay 回 null ⇒ 證明不了 ⇒ 403，與建畫布閘同碼同文案）。
 * 這不是 fail-closed 的回歸——建畫布/個人畫布路徑仍是 fail-open（見上），
 * 且查不到成員身份時唯一無法做的只有「讀別團的畫布」，不影響任何既有功能。
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
