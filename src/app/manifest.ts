import type { MetadataRoute } from "next";
import { SITE_SHORT_DESCRIPTION, SITE_TITLE } from "@/lib/site-copy";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // 安装对话框显示的就是这两个栏位：与分页标题／OG 卡同一份真源，
    // 免得这里还留著「不用注册中转站」那套旧介绍（2026-09-27 统一）。
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