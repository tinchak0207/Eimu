import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

// 非內容路由：API、後台、需登入的個人頁、登入回跳與內部預覽頁。
// /agent 只是跳回首頁的舊書籤路由，/agent-chat-preview 是內部工具。
const PRIVATE_PATHS = [
  "/api/",
  "/admin/",
  "/history",
  "/settings/",
  "/auth/",
  "/wechat-login",
  "/agent",
  "/agent-chat-preview",
];

export default async function robots(): Promise<MetadataRoute.Robots> {
  const siteUrl = await getSiteUrl();

  // 2026-09-27 全面翻新：明確放行 AI 檢索與回答引擎的爬蟲。
  // 目的很具體——回答引擎對 eimu.dev 的描述一直停在「又一个在线生图站」（甚至
  // 混進同名的個人作品集與 Easy IMU 硬體），那正好是我們最不想被貼的標籤。
  // 想要被引用就得讓它們讀得到：站點層級的介紹真源是 /llms.txt 與 /docs/*。
  // 產品頁面照舊放行，只擋 /api/ 與 /admin/ 這些非內容路由。
  const aiCrawlers = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "Claude-User",
    "PerplexityBot",
    "Google-Extended",
    "Applebot-Extended",
    "CCBot",
  ];

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Block non-content routes from crawl budget waste.
        disallow: PRIVATE_PATHS,
      },
      {
        userAgent: aiCrawlers,
        allow: "/",
        disallow: PRIVATE_PATHS,
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
