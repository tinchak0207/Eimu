import { NextRequest } from "next/server";
import { authenticateImageUser } from "./image-billing";

export interface ServerUserIdentity {
  id: number;
}

/**
 * 直接读取 `x-user-id` 请求头，不做任何校验。
 *
 * 这个头是客户端自己塞进去的（见 new-api-client.ts 的 bearerHeader），
 * 所以它只能表示「客户端自称是谁」，绝不能拿来授权访问任何属于用户的数据。
 * 保留它，是因为 checkin / proxy / image-billing / auth-me 需要把它透传给上游，
 * 真正的校验发生在上游那一侧。
 *
 * 任何直接返回或修改用户数据的路由，都必须改用 requireVerifiedUser。
 */
export function getStoredUserFromHeaders(req: NextRequest): ServerUserIdentity | null {
  const userIdHeader = req.headers.get("x-user-id");
  if (!userIdHeader) return null;

  const userId = Number(userIdHeader);
  if (!Number.isFinite(userId)) return null;

  return { id: userId };
}

export interface VerifiedUser {
  id: number;
  username: string;
}

export type VerifiedUserResult =
  | { ok: true; user: VerifiedUser }
  | { ok: false; status: number; message: string };

/**
 * 取得经过上游校验的用户身份。
 *
 * 校验方式是把 `Authorization` 和 `New-Api-User` 一起发给上游 `/api/user/self`：
 * 上游会拒绝「令牌持有者 ≠ 头里声称的 id」的请求，因此返回的 id 是可信的。
 * 复用 image-billing 的 authenticateImageUser —— 它自带 30 秒进程内缓存，
 * 刚生成过图的用户再来读历史不会多一次往返。
 *
 * requiredQuota 传 0：查看历史不该因为余额为零被拦在门外。
 */
export async function requireVerifiedUser(req: NextRequest): Promise<VerifiedUserResult> {
  const auth = await authenticateImageUser(req.headers, 0);

  if (!auth.ok) {
    // authenticateImageUser 的文案是为出图流程写的（「请先登录再生成图片」），
    // 放在读历史的场景里语义不对。401 统一改写成中性说法，
    // 其余状态（比如上游临时故障）保留原文，免得掩盖真实原因。
    const message = auth.status === 401 ? "请先登录。" : auth.message;
    return { ok: false, status: auth.status, message };
  }

  return { ok: true, user: { id: auth.user.id, username: auth.user.username } };
}
