import { NextRequest, NextResponse } from "next/server";

import { SPEC } from "./spec";

export const runtime = "nodejs";
export const dynamic = "auto"; // 依赖环境变数，不强制静态
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

/** 允许跨域读取的自家域名（docs 页同源读取不受影响；挡浏览器侧跨站抓 spec）。 */
const ALLOWED_ORIGINS = [
  "https://eimu.dev",
  "https://www.eimu.dev",
  "https://image.tinchak0207.xyz",
  "https://www.image.tinchak0207.xyz",
];

export function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : "";
  return NextResponse.json(SPEC, {
    headers: {
      ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin } : {}),
    },
  });
}
