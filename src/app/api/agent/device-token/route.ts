// POST /api/agent/device-token —— 桌面壳的「本机档案权限」换票端点（W7a，2026-10-05）。
//
// 为什么需要它：装置桥挂在闸道既有的 Bearer `sk-biz-*` 之后，而桌面壳载入的是**远端
// 页面**、壳内没有也不该有长期 key。旧设计只有「使用者手放 0600 key 档」这条操作者
// 路径 ⇒ 真实使用者装了 app 也永远停在 credentials_unavailable（四个权限档怎么选都
// 一样），这就是「最新安装包还是没有权限」的根因。
//
// 形态：已登录的页面打这里 → 站内以服务端持有的 B key 向闸道
// `POST /agent/v1/device-bridge/token` 换一张 `sk-dev-…` **短效票**（分钟级、闸道行程内
// 记忆体、重启即全失效＝可撤销）→ 原样回给页面 → 页面经窄 IPC 交给壳当 Bearer。
// 票**只在回应里**：本站不写 DB、不写 log、不落任何缓存（`no-store`）。
//
// 纯代理：身份由 resolveAgentCaller 统一解决（与 quota／sessions 同一套），这里不另造。

import { NextRequest, NextResponse } from "next/server";
import { callAgentGateway, type AgentGatewayResponse } from "@/lib/agent-gateway";
import { agentCallerFailureCode, resolveAgentCaller } from "@/lib/agent-session-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 与 VPS（闸道，矽谷）同区

/** 上游没给票期时的退路（与闸道预设 600s 同值）。 */
const FALLBACK_TTL_SEC = 600;

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

/**
 * 换算上游回应。**成功与否都不把上游原始 body 直接吐出去**：这条链路的 body 里带票
 * （`token`），任何错误路径都不得把它或 key 泄漏到浏览器可见的文字里。
 */
function toClientResponse(resp: AgentGatewayResponse): NextResponse {
  if (resp.status >= 200 && resp.status < 300) {
    const body = resp.json && typeof resp.json === "object" ? (resp.json as Record<string, unknown>) : {};
    const token = typeof body.token === "string" ? body.token : "";
    const gatewayBaseUrl = typeof body.gateway_base_url === "string" ? body.gateway_base_url : "";
    if (!token.startsWith("sk-dev-") || !/^https?:\/\//.test(gatewayBaseUrl)) {
      // 上游形状不符：宁可回 502，也不把半截东西交给壳。
      return fail(502, "本机档案换票回应格式不正确，请稍后重试。", "device_token_malformed");
    }
    const ttlRaw = Number(body.expires_in_sec);
    const expiresInSec = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : FALLBACK_TTL_SEC;
    return NextResponse.json(
      { success: true, token, gatewayBaseUrl, expiresInSec },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (resp.status === 404) {
    return fail(503, "本机档案桥未在此环境启用。", "device_bridge_disabled");
  }
  if (resp.status === 401 || resp.status === 403) {
    return fail(resp.status, "登录状态无法换取本机档案凭证，请重新登录后再试。", "device_token_unauthorized");
  }
  return fail(502, "本机档案换票服务暂时不可用，请稍后重试。", "device_token_unavailable");
}

export async function POST(req: NextRequest) {
  const caller = await resolveAgentCaller(req);
  if (!caller.ok) {
    return fail(caller.status, caller.message, agentCallerFailureCode(caller));
  }

  let resp: AgentGatewayResponse;
  try {
    // 必须带 `{}`：闸道的 device-bridge 路由用 readJsonBody，完全没有 body 或空 body 一律
    // 400 bad_request（→ 这里落成 502 device_token_unavailable，换票永远失败）；
    // 带了才会把 Content-Type 设成 application/json 并送出可解析的 JSON。
    resp = await callAgentGateway("/agent/v1/device-bridge/token", { method: "POST", key: caller.key, body: {} });
  } catch {
    return fail(502, "本机档案换票服务连接失败，请稍后重试。", "device_token_unreachable");
  }
  return toClientResponse(resp);
}