// B 端（`Authorization: Bearer sk-biz-…`）路由共用的 **OpenAI 风格错误体 + 认证闸**。
//
// 抽出来的唯一理由：`/api/biz/character-cards`、`/api/biz/character-resolve` 与保留的
// `/api/v1/character-cards` 必须回**逐位元同形**的错误体。形状一旦分叉，VPS 侧 agent 工具
// 的 `classifyError` 就分不出「认证失败 / 形状失败 / 上游失败」，只能靠猜。
//
// 形状与 `/v1/images/generations` 现存实现一致（`{ error: { message, type, code, param: null,
// trace_id } }` + `X-Request-Id` 响应头）；那边是历史真源，本次**未动**（它在生产被 next.config
// 的 beforeFiles 改写代理到控制面，改它没有收益）。本档只是把这套形状收成一处，避免第 N 份拷贝。
import { NextRequest, NextResponse } from "next/server";
import { withTraceId } from "@/lib/request-trace";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";

/**
 * 错误 type 值域。
 *
 * `insufficient_balance` = `/v1/*` 统一的余额不足 type（2026-09-28 契约，见 S2 §4），
 * `/openai/v1/*` 兼容层透传上游 402 时会带这个 type；此前不在值域里，透传就得靠 cast。
 * `insufficient_quota` 只有 legacy 生图分支用，仍然不从这条路出。
 */
export type BizOpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "insufficient_balance"
  | "api_error";

/**
 * OpenAI 风格的错误体；同一个 trace id 也落进 `X-Request-Id` 响应头，
 * 方便客户直接从抓包/网络面板里拿。
 */
export function bizErrorResponse(
  status: number,
  message: string,
  type: BizOpenAIErrorType,
  code: string,
  traceId: string,
) {
  return withTraceId(
    NextResponse.json({ error: { message, type, code, param: null, trace_id: traceId } }, { status }),
    traceId,
  );
}

/** 认证失败统一走这里：429 → rate_limit，403 → permission，其余按 authentication。 */
export function bizAuthErrorResponse(
  auth: { status: number; message: string; code: string },
  traceId: string,
) {
  const type: BizOpenAIErrorType =
    auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
  return bizErrorResponse(auth.status, auth.message, type, auth.code, traceId);
}

/**
 * 认证闸：成功返回 `{ ok: true, key }`（key 带 `id` / `userId`），
 * 失败返回可直接 `return` 的响应。
 */
export async function guardBizApiKey(req: NextRequest, traceId: string) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) return { ok: false as const, response: bizAuthErrorResponse(auth, traceId) };
  return { ok: true as const, key: auth.key };
}
