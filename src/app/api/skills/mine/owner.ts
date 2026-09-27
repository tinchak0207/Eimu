/**
 * 私有 skill 端點的身份解析（`/api/skills/mine` 兩支路由共用一份）。
 *
 * **不是第二套鑑權**：這裡只把既有入口的兩步接起來，零新邏輯——
 *   1. `resolveAgentCaller`（`agent-session-guard.ts`）＝七條 agent 路由共用的身份入口，
 *      內部強制 `requireVerifiedUser`（把 Authorization + New-Api-User 交上游
 *      `/api/user/self` 驗證，回來的 id 才可信），絕不讀 `x-user-id` 這種未校驗請求頭；
 *   2. `deriveMemoryOwnerKey`（`agent-memory-injection.ts`）＝與 gateway 注入/批次
 *      同一把演算法、同一套正典化，故使用者在私有庫寫入的 skill 能被同一身份的
 *      agent 召回到。
 * 與原本那條語義錯誤的 publish 端點（2026-09-27 已刪）逐字相同，差別只在
 * 抽出來給兩支端點共用，避免兩份複製品日後分叉。
 */

import { NextRequest, NextResponse } from "next/server";
import { deriveMemoryOwnerKey } from "@/lib/agent-memory-injection";
import { resolveAgentCaller } from "@/lib/agent-session-guard";

export const noStore = { "Cache-Control": "no-store" } as const;

export type SkillOwner = { ok: true; ownerKey: string } | { ok: false; response: NextResponse };

/**
 * 解析呼叫者的私有庫 ownerKey。
 *
 * 失敗語義：**未登入／憑證失效一律 401**（guard 這兩種情況都回 401，已自帶
 * `code: agent_not_signed_in`）；guard 的 5xx（agent 網關未啟用等基礎設施態）
 * 原樣帶出，**不冒充 401**——把故障說成「請先登入」會讓運維查錯方向。
 * 錯誤體與其他 skills 路由同款（`{ error, success:false }`），不新增第二套格式。
 */
export async function resolveSkillOwner(req: NextRequest): Promise<SkillOwner> {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: caller.status >= 500 ? "internal_error" : "unauthorized", success: false },
        { status: caller.status, headers: noStore },
      ),
    };
  }
  const ownerKey = await deriveMemoryOwnerKey(caller.key);
  if (!ownerKey) {
    return {
      ok: false,
      response: NextResponse.json({ error: "internal_error", success: false }, { status: 500, headers: noStore }),
    };
  }
  return { ok: true, ownerKey };
}
