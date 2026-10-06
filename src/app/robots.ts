import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

// 只留一条通用规则：/api/ 属非内容路由（爬它只是浪费 crawl budget）。
// 2026-10-05 红队：原本逐条列举 /admin、/settings、/auth、/agent… 等于在 robots.txt
// 里反向给出「哪些路径是敏感的」侦察字典；已全部移除，不再对外枚举敏感路径。
// 后台/登入等页面本身有鉴权闸，不靠 robots 挡。
const NON_CONTENT_PATHS = ["/api/"];

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
        disallow: NON_CONTENT_PATHS,
      },
      {
        userAgent: aiCrawlers,
        allow: "/",
        disallow: NON_CONTENT_PATHS,
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
