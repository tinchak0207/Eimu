import type { MetadataRoute } from "next";
import { SITE_SHORT_DESCRIPTION, SITE_TITLE } from "@/lib/site-copy";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // 安裝對話框顯示的就是這兩個欄位：與分頁標題／OG 卡同一份真源，
    // 免得這裡還留著「不用註冊中轉站」那套舊介紹（2026-09-27 統一）。
    name: SITE_TITLE,
    short_name: "Eimu",
    description: SITE_SHORT_DESCRIPTION,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#1f2328",
    icons: [
      { src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}