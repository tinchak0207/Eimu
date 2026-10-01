// /v1/assets — B 端资产包读写端点，供 agent 网关工具（VPS .opencode/tools/asset_*）用
// session key 读写用户的资产包。与 web 版 /api/assets 同源同 store，只是认证换成了
// B 端密钥（只认 `Authorization: Bearer sk-biz-…`，聚合工具不会转发 x-user-id）。
//
// 零计费端点：只读写资产包，不碰 reserve/refund/quota —— 任何计费改动都不属于这里。
// 错误体沿用 OpenAI 风格（{ error: { message, type, code } }），形状与
// /v1/images/generations 保持一致，VPS 侧 classifyError 直接按同一结构解析。
import { NextRequest, NextResponse } from "next/server";
import { getOrCreateTraceId, withTraceId } from "@/lib/request-trace";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import {
  AssetPackLimitError,
  deleteAssetPacks,
  listAssetPacks,
  normalizeAssetPack,
  saveAssetPack,
} from "@/lib/asset-pack-store";
import type { AssetPack } from "@/lib/asset-pack-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／閘道／image-data-api blob／控制面）都在矽谷，同區省一趟橫跨美國（2026-10-01 效能審計）

type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "api_error";

/**
 * OpenAI 风格的错误体。聚合工具大多按这个结构解析，形状必须对得上 ——
 * 与 /v1/images/generations 完全一致（message/type/code + trace_id），
 * 这样 VPS 的 classifyError 不用为 asset 路由单开一套解析。
 */
function errorResponse(
  status: number,
  message: string,
  type: OpenAIErrorType,
  code: string,
  traceId: string,
) {
  return withTraceId(
    NextResponse.json({ error: { message, type, code, param: null, trace_id: traceId } }, { status }),
    traceId,
  );
}

/** 认证失败统一走这里：429 → rate_limit，403 → permission，其余按 authentication。 */
function authErrorResponse(
  auth: { status: number; message: string; code: string },
  traceId: string,
) {
  const type: OpenAIErrorType =
    auth.status === 429 ? "rate_limit_error" : auth.status === 403 ? "permission_error" : "authentication_error";
  return errorResponse(auth.status, auth.message, type, auth.code, traceId);
}

/** 认证闸：成功返回 `{ ok: true, key }`，失败返回可直接返回的响应。 */
async function guard(req: NextRequest, traceId: string) {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")));
  if (!auth.ok) return { ok: false as const, response: authErrorResponse(auth, traceId) };
  return { ok: true as const, key: auth.key };
}

export async function GET(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await guard(req, traceId);
  if (!auth.ok) return auth.response;

  try {
    // q：标题/tags/语义摘要的小写包含搜索（与 web 版 /api/assets 同一条过滤规则）；
    // id：精确单包，供 asset_get 工具直接按 id 取包，不经过关键词搜索。
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
    const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
    let packs = await listAssetPacks(auth.key.userId);
    if (id) {
      packs = packs.filter((p) => p.id === id);
    } else if (q) {
      packs = packs.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.tags.some((tag) => tag.toLowerCase().includes(q)) ||
          (p.digest ?? "").toLowerCase().includes(q),
      );
    }
    return withTraceId(
      NextResponse.json({ success: true, packs }, { status: 200, headers: { "Cache-Control": "no-store" } }),
      traceId,
    );
  } catch (error) {
    console.error("[biz-assets] list failed:", error);
    return errorResponse(500, "读取资产包失败，请稍后再试。", "api_error", "internal_error", traceId);
  }
}

export async function PUT(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await guard(req, traceId);
  if (!auth.ok) return auth.response;

  // normalizeAssetPack 是唯一的形状验证关口：id/title 必填、items 逐项白名单校验、
  // tags/digest 截断 —— 非法直接 400，不默默截断或改写用户的请求。
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }
  const normalized = normalizeAssetPack(body);
  if (!normalized) {
    return errorResponse(
      400,
      "资产包数据无效（需要 id / title，items 每项需要合法 kind / title）。",
      "invalid_request_error",
      "invalid_payload",
      traceId,
    );
  }

  try {
    await saveAssetPack(auth.key.userId, normalized);
    return withTraceId(NextResponse.json({ success: true, pack: normalized }, { status: 200 }), traceId);
  } catch (error) {
    // 上限是 store 的诚实拒绝：数量到顶就明说，绝不静默截断。
    if (error instanceof AssetPackLimitError) {
      return errorResponse(400, error.message, "invalid_request_error", "asset_limit", traceId);
    }
    console.error("[biz-assets] save failed:", error);
    return errorResponse(500, "保存资产包失败，请稍后再试。", "api_error", "internal_error", traceId);
  }
}

export async function DELETE(req: NextRequest) {
  const traceId = getOrCreateTraceId(req);
  const auth = await guard(req, traceId);
  if (!auth.ok) return auth.response;

  let ids: string[] = [];
  try {
    const body = (await req.json()) as { ids?: unknown };
    ids = Array.isArray(body?.ids) ? body.ids.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return errorResponse(400, "请求体不是合法的 JSON。", "invalid_request_error", "invalid_json", traceId);
  }
  if (!ids.length) return errorResponse(400, "缺少 ids。", "invalid_request_error", "invalid_payload", traceId);

  try {
    await deleteAssetPacks(auth.key.userId, ids);
    return withTraceId(NextResponse.json({ success: true }, { status: 200 }), traceId);
  } catch (error) {
    console.error("[biz-assets] delete failed:", error);
    return errorResponse(500, "删除资产包失败，请稍后再试。", "api_error", "internal_error", traceId);
  }
}
