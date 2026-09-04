// agent 對話路由的統一身份與 key 解析入口。
//
// 所有 agent 對話路由都走這裡，不各自實作 —— 目的是把「身份校驗」和
// 「拿明文 key」兩個安全關鍵點釘在一個地方，誰想繞過都得先改這裡。
//
// 身份必須用 requireVerifiedUser（server-user.ts:47 把 Authorization + New-Api-User
// 交給上游 /api/user/self 驗證，回來的 id 才是可信的），絕對不能用
// getStoredUserFromHeaders —— 那只是讀一個客戶端自己塞的 x-user-id 頭，
// 不具任何信任價值。

import { NextRequest } from "next/server";
import { agentGatewayEnabled } from "./agent-gateway";
import { requireVerifiedUser } from "./server-user";
import { AgentKeyConfigError, getOrCreateAgentKeyForUser } from "./agent-user-key";
import { shouldBypassAuthForLocalTest } from "./local-test-mode";

export type AgentCaller =
  | { ok: true; userId: number; key: string }
  | { ok: false; status: number; message: string; code?: string };

/**
 * 失敗的 caller 該回什麼 code —— 七條 agent 路由共用一份判斷。
 *
 * 以前每條路由各自寫 `caller.status >= 500 ? "agent_unavailable" : "agent_auth_failed"`，
 * 七份複製品意味著任何細分都得改七次，於是沒人改。code 的歸屬屬於 guard，
 * 不屬於各路由。
 */
export function agentCallerFailureCode(caller: Extract<AgentCaller, { ok: false }>): string {
  if (caller.code) return caller.code;
  return caller.status >= 500 ? "agent_unavailable" : "agent_auth_failed";
}

export async function resolveAgentCaller(req: NextRequest): Promise<AgentCaller> {
  if (!agentGatewayEnabled()) {
    return { ok: false, status: 503, message: "Agent 对话未启用。" };
  }

  // LOCAL_TEST_MODE：本機視覺重放/截圖用，直接拿 B 端 key 打真實 gateway。
  // 跳過 per-user 派生（隨機 key 沒登記到 gateway 會被拒），且只影響本地開發。
  if (shouldBypassAuthForLocalTest(process.env)) {
    const bizKey = process.env.IMAGE_STUDIO_BIZ_KEY?.trim();
    if (!bizKey) {
      return {
        ok: false,
        status: 503,
        message: "local-test 需要 IMAGE_STUDIO_BIZ_KEY 環境變數。",
        code: "agent_key_not_configured",
      };
    }
    return { ok: true, userId: 0, key: bizKey };
  }

  // 「没送凭证」和「凭证被上游拒绝」必须分得开。
  // requireVerifiedUser 会把所有 401 改写成同一句「请先登录。」，从外面看两者
  // 一模一样 —— 传輸层少送一个 x-user-id 头（authenticateImageUser 的
  // `if (!auth || !userId)` 直接 401）曾经因此被误判成「登录过期」查了两轮。
  // 这里先自己判一次，让 401 说得出自己是哪一种。
  const authHeader = req.headers.get("authorization")?.trim();
  const idHeader = (req.headers.get("x-user-id") ?? req.headers.get("New-Api-User"))?.trim();
  if (!authHeader || !idHeader) {
    return {
      ok: false,
      status: 401,
      message: "请先登录后再使用 AI 助理。",
      code: "agent_not_signed_in",
    };
  }

  const verified = await requireVerifiedUser(req);
  if (!verified.ok) {
    const message =
      verified.status === 401 ? "登录状态已失效，请重新登录后再试。" : verified.message;
    return { ok: false, status: verified.status, message };
  }

  try {
    const key = await getOrCreateAgentKeyForUser(verified.user.id);
    return { ok: true, userId: verified.user.id, key };
  } catch (error) {
    // 不把 error.message 原樣回給客戶端：它可能含內部路徑細節。
    // error 對象本身不會夾帶明文 key（agent-user-key.ts 的所有錯誤都是固定字串）。
    console.error("[agent] 取得 agent key 失敗。", error);

    // 漏配 env 不該偽裝成「稍後重試」—— 它不會自己好。code 分開，文案分開，
    // 但都不吐內部細節（少了哪個變量只寫進伺服器日誌）。
    if (error instanceof AgentKeyConfigError) {
      return {
        ok: false,
        status: 503,
        message: "AI 助理尚未完成配置，请联系管理员。",
        code: "agent_key_not_configured",
      };
    }
    return {
      ok: false,
      status: 503,
      message: "Agent 服务暂不可用，请稍后重试。",
      code: "agent_key_unavailable",
    };
  }
}
