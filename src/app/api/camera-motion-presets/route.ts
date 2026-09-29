/**
 * GET /api/camera-motion-presets — 站內**公開只讀**運鏡預設庫列舉/檢索。
 *
 * query：`q=<關鍵詞>`（子字串，命中 key/中文名/膠囊標籤/prompt/檢索詞）、
 * `tag=<檢索詞>`（精確命中 tags）。兩者可並用。
 * 回應：`{ presets, total, tags }`；`total` = 過濾後條數（本端點不分頁、全量回）；
 * `tags` = 全庫檢索詞去重 facet（與篩選無關）。
 *
 * 公開面：**無需登入**、零寫入、不計費、不動任何帳本（沿用同 repo 公開只讀 route
 * 的 no-store 慣例；錯誤體沿用 `recipe-templates/route.ts` 的 fail() 形狀）。
 */

import { NextRequest, NextResponse } from "next/server";
import {
  listCameraMotionPresetTags,
  listCameraMotionPresets,
} from "@/lib/camera-motion-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
