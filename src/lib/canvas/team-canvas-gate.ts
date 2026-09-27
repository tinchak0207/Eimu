// 團隊建畫布閘（片F 面 2 的接線）：把 canMemberCreateSharedCanvas() 接到畫布落盤路徑上。
//
// 真源：全站**唯一**的畫布建立/落盤入口是 `PUT /api/canvas/projects`
// （`saveCanvasProject` upsert by id；前端所有建立路徑——工具箱「新建画布」、
// 模板鋪畫布、agent 下發節點後 debounce 存檔——最終都收斂到這條 PUT）。
// 因此閘設在這裡，而不是各前端入口——否則新入口一加就漏。
//
// 語義（與 team-governance.canMemberCreateSharedCanvas 逐字對齊，不另立判斷）：
//   ★ 非團隊成員（個人帳號）→ 不受此閘，一律放行。
//   ★ owner / admin（含團隊主帳）→ 恆放行。
//   ★ 成員（role=member）→ 依團隊設定 member_create_canvas：開啟放行，關閉拒絕。
//   ★ 治理層未配置（C 端／本地）→ 放行（與既有降級一致）。
//
// 「不得產生半成品專案」：先判後存——拒絕時**不呼叫** saveCanvasProject，
// 專案數維持不變。既有的「更新」不是「建」：已存在的專案 id 不受事後關閘影響
// （否則團隊一關開關，成員手上既有畫布會存不進去，等於資料損失）。
//
// 本模組只讀治理層與畫布 store，不碰任何點數/計費（禁影子帳本）。

import { canMemberCreateSharedCanvas, TEAM_CANVAS_FORBIDDEN_CODE, type CanvasPermission } from "@/lib/generation-core/team-governance";
import type { GenerationSql } from "@/lib/generation-core/database";

import { readCanvasProject, saveCanvasProject } from "./project-store";
import type { CanvasProject } from "./types";

export interface TeamCanvasGateDeps {
  /** 治理層 SQL（測試注入假控制面用；缺省走 process.env 的正式連線）。 */
  sql?: GenerationSql;
  /** 測試注入點：缺省＝真實治理閘 canMemberCreateSharedCanvas()。 */
  permission?: (userId: number) => Promise<CanvasPermission>;
}

export interface TeamCanvasGateDenied {
  ok: false;
  status: 403;
  code: string;
  message: string;
}

/**
 * 帶團隊閘的畫布落盤：先判權限，拒絕則不寫（無半成品）；放行後才走既有 saveCanvasProject。
 *
 * 回傳 `{ ok: true }` ＝已落盤；`{ ok: false, ... }` ＝被團隊閘拒（呼叫端原樣轉 403）。
 */
export async function saveCanvasProjectWithTeamGate(
  userId: number,
  project: CanvasProject,
  deps: TeamCanvasGateDeps = {},
): Promise<{ ok: true } | TeamCanvasGateDenied> {
  const permission = await (deps.permission
    ? deps.permission(userId)
    : canMemberCreateSharedCanvas(userId, { sql: deps.sql }));

  if (!permission.allowed) {
    // 只有「建新畫布」受閘；既有專案（更新/自動存檔）不受事後關閘影響。
    const existing = await readCanvasProject(userId, project.id);
    if (!existing) {
      return {
        ok: false,
        status: 403,
        code: permission.code ?? TEAM_CANVAS_FORBIDDEN_CODE,
        message: permission.message,
      };
    }
  }

  await saveCanvasProject(userId, project);
  return { ok: true };
}
