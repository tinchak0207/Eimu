// 控制面侧的 PWA 登录交接（handoff）端点。调用方是 Vercel 上的
// src/lib/pwa-handoff.ts：Vercel 无控制面 DB 直连（与 biz-keys 同一约束），
// 于是经签名通道把 create/deliver/poll/claim 四个 op 转投到这里落库。
//
// 鉴权复用 biz-key-sync 的 HMAC 通道（signatureDomain "pwa-handoff"），
// 与 supplier-health 路由同一骨架；不回显任何密钥或内部错误细节。

import { NextRequest, NextResponse } from "next/server";
import {
  BIZ_KEY_SYNC_SIGNATURE_HEADER,
  BIZ_KEY_SYNC_TIMESTAMP_HEADER,
  verifyBizKeySync,
} from "@/lib/biz-key-sync";
import {
  claimHandoff,
  createHandoffTicket,
  deliverHandoff,
  pollHandoff,
} from "@/lib/pwa-handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNATURE_DOMAIN = "pwa-handoff";

interface HandoffBody {
  op?: unknown;
  ticket?: unknown;
  token?: unknown;
  user?: unknown;
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

  let body: HandoffBody;
  try {
    body = JSON.parse(rawBody) as HandoffBody;
  } catch {
    return NextResponse.json({ ok: false, message: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  try {
    switch (body.op) {
      case "create": {
        const ticket2 = await createHandoffTicket();
        return NextResponse.json({ ok: true, ticket: ticket2 });
      }
      case "deliver": {
        if (!ticket || typeof body.token !== "string") {
          return NextResponse.json({ ok: false, message: "缺少 ticket 或 token。" }, { status: 400 });
        }
        const delivered = await deliverHandoff(ticket, body.token, body.user);
        return NextResponse.json({ ok: true, delivered });
      }
      case "poll": {
        if (!ticket) return NextResponse.json({ ok: false, message: "缺少 ticket。" }, { status: 400 });
        const status = await pollHandoff(ticket);
        return NextResponse.json({ ok: true, status });
      }
      case "claim": {
        if (!ticket) return NextResponse.json({ ok: false, message: "缺少 ticket。" }, { status: 400 });
        const claimed = await claimHandoff(ticket);
        return NextResponse.json({ ok: true, claimed });
      }
      default:
        return NextResponse.json({ ok: false, message: "未知 op。" }, { status: 400 });
    }
  } catch (error) {
    // 不洩漏内部错误细节（DB 拓扑/SQL 等），只留固定文案；细节进日志。
    console.error("[internal/pwa-handoff] op failed", error);
    return NextResponse.json({ ok: false, message: "交接票据处理失败。" }, { status: 500 });
  }
}
