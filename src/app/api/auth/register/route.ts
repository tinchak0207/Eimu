import { NextResponse } from "next/server";

export function POST() {
  return NextResponse.json(
    { success: false, message: "账号密码注册已停用，请使用 GitHub 登录。" },
    { status: 410 },
  );
}
