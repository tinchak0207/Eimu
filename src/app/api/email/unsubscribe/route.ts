// 營銷郵件一鍵退訂（GET＝點連結；POST＝RFC 8058 List-Unsubscribe-Post 一鍵）。
// 跑在控制面（next.config beforeFiles 代理），因為 email_preference 在控制面 postgres。

import { NextRequest, NextResponse } from "next/server";
import { generationDatabaseConfigured, getGenerationSql } from "@/lib/generation-core/database";
import { setMarketingOptOut, unsubscribeSecret, verifyUnsubscribeToken } from "@/lib/lifecycle-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(title: string, body: string, status: number): NextResponse {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#1d1d1f">
<div style="max-width:420px;margin:80px auto;background:#fff;border-radius:20px;padding:32px 28px">
<h1 style="font-size:20px;margin:0 0 12px">${title}</h1><p style="font-size:15px;line-height:1.7;margin:0;color:#6e6e73">${body}</p></div></body></html>`;
  return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const userId = Number(req.nextUrl.searchParams.get("u"));
  const token = req.nextUrl.searchParams.get("t") ?? "";
  const secret = unsubscribeSecret();
  if (!secret || !generationDatabaseConfigured()) return page("暂时无法退订", "请稍后再试。", 503);
  if (!verifyUnsubscribeToken(userId, token, secret)) return page("链接无效", "这个退订链接无效或已损坏。", 400);
  try {
    await setMarketingOptOut(getGenerationSql(), userId);
  } catch {
    return page("暂时无法退订", "请稍后再试。", 503);
  }
  return page("已退订", "之后不会再收到 Emu 的提醒邮件。账户相关的必要通知不受影响。", 200);
}

export const GET = handle;
export const POST = handle;
