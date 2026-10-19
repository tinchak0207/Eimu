/**
 * 私有 skill 端点的身份解析（`/api/skills/mine` 两支路由共用一份）。
 *
 * **不是第二套鉴权**：这里只把既有入口的两步接起来，零新逻辑——
 *   1. `resolveAgentCaller`（`agent-session-guard.ts`）＝七条 agent 路由共用的身份入口，
 *      内部强制 `requireVerifiedUser`（把 Authorization + New-Api-User 交上游
 *      `/api/user/self` 验证，回来的 id 才可信），绝不读 `x-user-id` 这种未校验请求头；
 *   2. `deriveMemoryOwnerKey`（`agent-memory-injection.ts`）＝与 gateway 注入/批次
 *      同一把演算法、同一套正典化，故使用者在私有库写入的 skill 能被同一身份的
 *      agent 召回到。
 * 与原本那条语义错误的 publish 端点（2026-09-27 已删）逐字相同，差别只在
 * 抽出来给两支端点共用，避免两份复制品日后分叉。
 */

import { NextRequest, NextResponse } from "next/server";
import { deriveMemoryOwnerKey } from "@/lib/agent-memory-injection";
import { resolveAgentCaller } from "@/lib/agent-session-guard";

export const noStore = { "Cache-Control": "no-store" } as const;

export type SkillOwner = { ok: true; ownerKey: string } | { ok: false; response: NextResponse };

/**
 * 解析呼叫者的私有库 ownerKey。
 *
 * 失败语义：**未登入／凭证失效一律 401**（guard 这两种情况都回 401，已自带
 * `code: agent_not_signed_in`）；guard 的 5xx（agent 网关未启用等基础设施态）
 * 原样带出，**不冒充 401**——把故障说成「请先登入」会让运维查错方向。
 * 错误体与其他 skills 路由同款（`{ error, success:false }`），不新增第二套格式。
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
