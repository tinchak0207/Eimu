import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

// 非内容路由：API、后台、需登入的个人页、登入回跳与内部预览页。
// /agent 只是跳回首页的旧书签路由，/agent-chat-preview 是内部工具。
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

  // 2026-09-27 全面翻新：明确放行 AI 检索与回答引擎的爬虫。
  // 目的很具体——回答引擎对 eimu.dev 的描述一直停在「又一个在线生图站」（甚至
  // 混进同名的个人作品集与 Easy IMU 硬体），那正好是我们最不想被贴的标签。
  // 想要被引用就得让它们读得到：站点层级的介绍真源是 /llms.txt 与 /docs/*。
  // 产品页面照旧放行，只挡 /api/ 与 /admin/ 这些非内容路由。
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
