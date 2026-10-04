import { NextResponse } from "next/server";

export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

export function POST() {
  return NextResponse.json(
    { success: false, message: "账号密码注册已停用，请使用 GitHub 登录。" },
    { status: 410 },
  );
}
