// 控制面侧的 new-api 稳定会话令牌（session token）端点。调用方是 Vercel 上的
// src/lib/newapi-session-token.ts：Vercel 无控制面 DB 直连，也够不到
// new-api 内网地址，于是经签名通道把 {userId, sessionCookie} 转投到这里，
// 由控制面执行「查表 → 验活 → 复用/重新生成覆盖」。
//
// 鉴权复用 biz-key-sync 的 HMAC 通道（signatureDomain "newapi-session-token"），
// 与 pwa-handoff/supplier-health 路由同一骨架；不回显任何密钥或内部错误细节。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import { ensureNewApiSessionToken, lookupUserIdByToken } from "@/lib/newapi-session-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNATURE_DOMAIN = "newapi-session-token";

interface SessionTokenBody {
  userId?: unknown;
  sessionCookie?: unknown;
}

export async function POST(req: NextRequest) {
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!secret) return NextResponse.json({ ok: false, message: "签名通道未配置。" }, { status: 503 });

  // 签名覆盖的是字节：必须读原文再解析。
  const rawBody = await req.text();
  const verified = verifyBizKeySync({
    secret,
    timestamp: req.headers.get(BIZ_KEY_SYNC_TIMESTAMP_HEADER),
    signature: req.headers.get(BIZ_KEY_SYNC_SIGNATURE_HEADER),
    rawBody,
    signatureDomain: SIGNATURE_DOMAIN,
  });
  if (!verified) return NextResponse.json({ ok: false, message: "签名校验失败。" }, { status: 401 });

  let body: SessionTokenBody & { op?: unknown; token?: unknown };
  try {
    body = JSON.parse(rawBody) as SessionTokenBody & { op?: unknown; token?: unknown };
  } catch {
    return NextResponse.json({ ok: false, message: "请求体不是合法 JSON。" }, { status: 400 });
  }

  // op=lookup：稳定 token 反查 userId（/api/user/self 强制 New-Api-User 头，
  // 前端 user 存储可能是坏残留，id 唯一可信源是这张表）。
  if (body.op === "lookup") {
    if (typeof body.token !== "string" || !body.token) {
      return NextResponse.json({ ok: false, message: "缺少 token。" }, { status: 400 });
    }
    const userId = await lookupUserIdByToken(body.token);
    if (!userId) return NextResponse.json({ ok: false }, { status: 404 });
    return NextResponse.json({ ok: true, userId });
  }

  const userId = typeof body.userId === "number" ? body.userId : Number.NaN;
  const sessionCookie = typeof body.sessionCookie === "string" ? body.sessionCookie : "";
  if (!Number.isInteger(userId) || userId <= 0 || !sessionCookie) {
    return NextResponse.json({ ok: false, message: "缺少 userId 或 sessionCookie。" }, { status: 400 });
  }

  try {
    const result = await ensureNewApiSessionToken(userId, sessionCookie);
    if (!result.ok) {
      return NextResponse.json({ ok: false, message: "会话令牌处理失败。" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, token: result.token, reused: result.reused });
  } catch (error) {
    // 不洩漏内部错误细节（DB 拓扑/网关拓扑/SQL 等），只留固定文案；细节进日志。
    console.error("[internal/newapi-session-token] ensure failed", error);
    return NextResponse.json({ ok: false, message: "会话令牌处理失败。" }, { status: 500 });
  }
}
