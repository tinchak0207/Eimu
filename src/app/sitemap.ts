import type { MetadataRoute } from "next";
import { USE_CASES } from "@/lib/use-cases";
import { getSiteUrl } from "@/lib/site-url";

// Static pages with explicit lastmod so Googlebot sees a stable signal.
// Avoid new Date() on every deploy — it would make every URL look freshly
// modified and burn crawl budget on pages that haven't actually changed.
const CONTENT_UPDATED = new Date("2026-08-15");

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const siteUrl = await getSiteUrl();

  const corePages: MetadataRoute.Sitemap = [
    { url: siteUrl, lastModified: CONTENT_UPDATED, changeFrequency: "weekly", priority: 1.0 },
    { url: `${siteUrl}/pricing`, lastModified: CONTENT_UPDATED, changeFrequency: "monthly", priority: 0.9 },
    { url: `${siteUrl}/docs`, lastModified: CONTENT_UPDATED, changeFrequency: "monthly", priority: 0.6 },
  ];

  const useCasePages: MetadataRoute.Sitemap = USE_CASES.map((uc) => ({
    url: `${siteUrl}/use-cases/${uc.slug}`,
    lastModified: CONTENT_UPDATED,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  return [...corePages, ...useCasePages];
}
