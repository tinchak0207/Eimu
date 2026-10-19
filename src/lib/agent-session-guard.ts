// agent 对话路由的统一身份与 key 解析入口。
//
// 所有 agent 对话路由都走这里，不各自实作 —— 目的是把「身份校验」和
// 「拿明文 key」两个安全关键点钉在一个地方，谁想绕过都得先改这里。
//
// 身份必须用 requireVerifiedUser（server-user.ts:47 把 Authorization + New-Api-User
// 交给上游 /api/user/self 验证，回来的 id 才是可信的），绝对不能用
// getStoredUserFromHeaders —— 那只是读一个客户端自己塞的 x-user-id 头，
// 不具任何信任价值。

import { NextRequest } from "next/server";
import { agentGatewayEnabled } from "./agent-gateway";
import { requireVerifiedUser } from "./server-user";
import { AgentKeyConfigError, getOrCreateAgentKeyForUser } from "./agent-user-key";
import { shouldBypassAuthForLocalTest } from "./local-test-mode";

export type AgentCaller =
  | { ok: true; userId: number; key: string }
  | { ok: false; status: number; message: string; code?: string };

/**
 * 失败的 caller 该回什么 code —— 七条 agent 路由共用一份判断。
 *
 * 以前每条路由各自写 `caller.status >= 500 ? "agent_unavailable" : "agent_auth_failed"`，
 * 七份复制品意味著任何细分都得改七次，于是没人改。code 的归属属于 guard，
 * 不属于各路由。
 */
export function agentCallerFailureCode(caller: Extract<AgentCaller, { ok: false }>): string {
  if (caller.code) return caller.code;
  return caller.status >= 500 ? "agent_unavailable" : "agent_auth_failed";
}

export async function resolveAgentCaller(req: NextRequest): Promise<AgentCaller> {
  if (!agentGatewayEnabled()) {
    return { ok: false, status: 503, message: "Agent 对话未启用。" };
  }

  // LOCAL_TEST_MODE：本机视觉重放/截图用，直接拿 B 端 key 打真实 gateway。
  // 跳过 per-user 派生（随机 key 没登记到 gateway 会被拒），且只影响本地开发。
  if (shouldBypassAuthForLocalTest(process.env)) {
    const bizKey = process.env.IMAGE_STUDIO_BIZ_KEY?.trim();
    if (!bizKey) {
      return {
        ok: false,
        status: 503,
        message: "local-test 需要 IMAGE_STUDIO_BIZ_KEY 环境变数。",
        code: "agent_key_not_configured",
      };
    }
    return { ok: true, userId: 0, key: bizKey };
  }

  // 「没送凭证」和「凭证被上游拒绝」必须分得开。
  // requireVerifiedUser 会把所有 401 改写成同一句「请先登录。」，从外面看两者
  // 一模一样 —— 传输层少送一个 x-user-id 头（authenticateImageUser 的
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
    // 不把 error.message 原样回给客户端：它可能含内部路径细节。
    // error 对象本身不会夹带明文 key（agent-user-key.ts 的所有错误都是固定字串）。
    console.error("[agent] 取得 agent key 失败。", error);

    // 漏配 env 不该伪装成「稍后重试」—— 它不会自己好。code 分开，文案分开，
    // 但都不吐内部细节（少了哪个变量只写进伺服器日志）。
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
