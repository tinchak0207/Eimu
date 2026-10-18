import { NextResponse } from "next/server";

export const preferredRegion = "sfo1";
export const dynamic = "force-dynamic";

// 废弃：不再把访客重定向去 Adobe 授权，避免未登录请求触发凭证写入。
export async function GET() {
  return NextResponse.json(
    { error: "凭证只能经环境变量配置" },
    { status: 410 },
  );
}
