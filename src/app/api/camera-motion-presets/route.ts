/**
 * GET /api/camera-motion-presets — 站内**公开只读**运镜预设库列举/检索。
 *
 * query：`q=<关键词>`（子字串，命中 key/中文名/胶囊标签/prompt/检索词）、
 * `tag=<检索词>`（精确命中 tags）。两者可并用。
 * 回应：`{ presets, total, tags }`；`total` = 过滤后条数（本端点不分页、全量回）；
 * `tags` = 全库检索词去重 facet（与筛选无关）。
 *
 * 公开面：**无需登入**、零写入、不计费、不动任何帐本（沿用同 repo 公开只读 route
 * 的 no-store 惯例；错误体沿用 `recipe-templates/route.ts` 的 fail() 形状）。
 */

import { NextRequest, NextResponse } from "next/server";
import {
  listCameraMotionPresetTags,
  listCameraMotionPresets,
} from "@/lib/camera-motion-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sfo1"; // 上游（VPS：new-api／闸道／image-data-api blob／控制面）都在矽谷，同区省一趟横跨美国（2026-10-01 效能审计）

const noStore = { "Cache-Control": "no-store" } as const;

function fail(status: number, message: string, code: string) {
  return NextResponse.json({ success: false, message, code }, { status, headers: noStore });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  try {
    const presets = listCameraMotionPresets({ query: q, tag });
    return NextResponse.json(
      { presets, total: presets.length, tags: listCameraMotionPresetTags() },
      { headers: noStore },
    );
  } catch (error) {
    console.error("[camera-motion-presets] list failed", error);
    return fail(503, "运镜预设库暂时不可用，请稍后再试。", "camera_motion_read_failed");
  }
}
