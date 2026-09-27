import type { MetadataRoute } from "next";
import { USE_CASES } from "@/lib/use-cases";
import { USE_CASE_CATEGORIES } from "@/lib/use-case-categories";
import { WORKFLOW_PAGES } from "@/lib/workflow-pages";
import { getSiteUrl } from "@/lib/site-url";

// Static pages with explicit lastmod so Googlebot sees a stable signal.
// Avoid new Date() on every deploy — it would make every URL look freshly
// modified and burn crawl budget on pages that haven't actually changed.
//
// 2026-09-27 全面翻新：值從 2026-08-15 更新到當日——首頁 metadata／JSON-LD／FAQ、
// llms.txt、文件中心這幾處真的改了，crawler 有理由重抓。順手把文件中心六個
// 子頁與 /status 補進 sitemap（它們是回答引擎要判斷 Eimu 會什麼時最該讀的頁，
// 先前只能靠站內連結被發現）。
//
// 同日 SEO 重構：102 個 `<行業>-<n>` 模板門頁移出 sitemap（已 301 到行業樞紐），
// 補進 /use-cases 總索引、17 個行業樞紐、/workflows 與 8 個產線落地頁。
const CONTENT_UPDATED = new Date("2026-09-27");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = await getSiteUrl();

  const corePages: MetadataRoute.Sitemap = [
    { url: siteUrl, lastModified: CONTENT_UPDATED, changeFrequency: "weekly", priority: 1.0 },
    { url: `${siteUrl}/pricing`, lastModified: CONTENT_UPDATED, changeFrequency: "monthly", priority: 0.9 },
    { url: `${siteUrl}/use-cases`, lastModified: CONTENT_UPDATED, changeFrequency: "weekly", priority: 0.9 },
    { url: `${siteUrl}/workflows`, lastModified: CONTENT_UPDATED, changeFrequency: "weekly", priority: 0.9 },
    { url: `${siteUrl}/docs`, lastModified: CONTENT_UPDATED, changeFrequency: "monthly", priority: 0.6 },
    { url: `${siteUrl}/status`, lastModified: CONTENT_UPDATED, changeFrequency: "daily", priority: 0.3 },
  ];

  const docPages: MetadataRoute.Sitemap = [
    "assistant",
    "workflow",
    "history",
    "billing",
    "mcp",
    "api",
  ].map((slug) => ({
    url: `${siteUrl}/docs/${slug}`,
    lastModified: CONTENT_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.5,
  }));

  const workflowPages: MetadataRoute.Sitemap = WORKFLOW_PAGES.map((page) => ({
    url: `${siteUrl}/workflows/${page.slug}`,
    lastModified: CONTENT_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.85,
  }));

  const categoryPages: MetadataRoute.Sitemap = USE_CASE_CATEGORIES.map((category) => ({
    url: `${siteUrl}/use-cases/${category.slug}`,
    lastModified: new Date(category.updated),
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  const guidePages: MetadataRoute.Sitemap = USE_CASES.map((uc) => ({
    url: `${siteUrl}/use-cases/${uc.slug}`,
    lastModified: CONTENT_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  return [...corePages, ...workflowPages, ...categoryPages, ...guidePages, ...docPages];
}
