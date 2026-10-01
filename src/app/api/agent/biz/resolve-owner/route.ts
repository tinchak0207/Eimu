// /api/agent/biz/resolve-owner —— B 端密钥属主解析：raw key → 派生 key 正典化。
//
// 背景：插件直连 store.tinchak0207.xyz/agent/v1/* 时带的是 B 端 key 本身，
// 网关按 key 字符串隔离身份空间 —— 与 /api/agent/biz/agent/v1/* 代理路径
// （换发成 getOrCreateAgentKeyForUser 派生 key）形成两个互不可见的身份空间。
// 网关在验证 raw key 后调用本端点把身份正典化为属主派生 key，此后
// 直连 = biz 代理 = 同一空间，settings / sessions / beast 开关跨路一致。
//
// 安全不变量（与 /api/agent/biz/[...path] 同一套）：
// - B 端密钥与派生 key 只出现在鉴权与响应的 canonical_key 字段里，
//   任何 log / 错误响应都不准夹带（错误一律固定文案）。
// - 鉴权失败原样回 authenticateBizApiKey 的 status/message/code。

import { NextRequest, NextResponse } from "next/server";
import { readBearerToken } from "@/lib/biz-api-keys";
import { authenticateBizApiKey } from "@/lib/biz-api-key-store";
import { AgentKeyConfigError, getOrCreateAgentKeyForUser } from "@/lib/agent-user-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 與 VPS（閘道/控制面 DB，矽谷）同區：每次上游往返省一趟橫跨美國（2026-10-01 效能審計）

function fail(status: number, message: string, code: string): NextResponse {
  return NextResponse.json({ success: false, error: message, code }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateBizApiKey(readBearerToken(req.headers.get("authorization")), {
    // 不计限流：调用方是网关（每个 agent 请求都可能触发），网关侧另有
    // TTL 缓存兜底；在这里再记一次限流只会让低频插件的配额被网关流量打爆。
    consumeRateLimit: false,
  });
  if (!auth.ok) {
    return fail(auth.status, auth.message, auth.code);
  }

  let canonicalKey: string;
  try {
    canonicalKey = await getOrCreateAgentKeyForUser(auth.key.userId);
  } catch (error) {
    // 漏配 env 与临时故障区分 code（与 biz 代理路由同一套语义），文案固定。
    if (error instanceof AgentKeyConfigError) {
      return fail(503, "服务暂不可用，请稍后重试。", "agent_key_not_configured");
    }
    return fail(503, "服务暂不可用，请稍后重试。", "agent_key_unavailable");
  }

  // user_id（G4，2026-09-17）：屬主數字 id，**非密**（金鑰字面值才是密，照舊不出本響應）。
  // gateway 對 agent 觸發的成片導出要向控制面報 `web:<userId>` tenant——控制面不持有
  // agent key 明文（單向哈希），反解不了 owner，所以屬主身份必須在這個既有正典化回應裡
  // 順帶給出。缺了它，導出索引無法歸屬（ingest 會 422）。
  return NextResponse.json({ canonical_key: canonicalKey, user_id: auth.key.userId });
}
