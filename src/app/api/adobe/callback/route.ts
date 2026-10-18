import { NextResponse } from "next/server";

export const preferredRegion = "sfo1";
export const dynamic = "force-dynamic";

// 废弃：禁止用公开 blob 或 process.env 持久化 Adobe token。
// 凭证只能经环境变量配置，本路由不再交换、不再落盘。
export async function GET() {
  return NextResponse.json(
    { error: "凭证只能经环境变量配置" },
    { status: 410 },
  );
}
