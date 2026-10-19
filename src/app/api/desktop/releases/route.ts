import { NextResponse } from "next/server";

import { DESKTOP_RELEASES } from "@/lib/desktop-releases";

/**
 * GET /api/desktop/releases
 *
 * 对外提供桌面壳目前可下载的最新产物（URL／大小／sha256／副档名），供网页端
 * 旧壳提示与任何外部检查用。资料**直接投射** `src/lib/desktop-releases.ts` 的
 * `DESKTOP_RELEASES`（单一真源），此档不另抄一份网址或版本。
 *
 * `version`（top-level）是「已存在最新版本」标记（两平台可不同步）；`releases.<platform>.version`
 * 才是**该平台产物自身的版本**（两平台可各自独立），网页端旧壳提示靠它逐平台比对。
 *
 * 快取：`public, max-age=60`——短快取让版本一换就生效，又不至于每次进站都回源。
 * 内容全为公开下载资讯，不含任何 secret。
 */
export function GET() {
  const { version, linux, windows } = DESKTOP_RELEASES;
  return NextResponse.json(
    {
      version,
      releases: {
        linux: {
          version: linux.version,
          url: linux.url,
          size: linux.size,
          sha256: linux.sha256,
          ext: linux.ext,
        },
        windows: {
          version: windows.version,
          url: windows.url,
          size: windows.size,
          sha256: windows.sha256,
          ext: windows.ext,
        },
      },
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
