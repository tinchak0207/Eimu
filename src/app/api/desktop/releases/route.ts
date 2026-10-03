import { NextResponse } from "next/server";

import { DESKTOP_RELEASES } from "@/lib/desktop-releases";

/**
 * GET /api/desktop/releases
 *
 * 對外提供桌面殼目前可下載的最新產物（URL／大小／sha256／副檔名），供網頁端
 * 舊殼提示與任何外部檢查用。資料**直接投射** `src/lib/desktop-releases.ts` 的
 * `DESKTOP_RELEASES`（單一真源），此檔不另抄一份網址或版本。
 *
 * `version`（top-level）是「已存在最新版本」標記（兩平台可不同步）；`releases.<platform>.version`
 * 才是**該平台產物自身的版本**（兩平台可各自獨立），網頁端舊殼提示靠它逐平台比對。
 *
 * 快取：`public, max-age=60`——短快取讓版本一換就生效，又不至於每次進站都回源。
 * 內容全為公開下載資訊，不含任何 secret。
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
