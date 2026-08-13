import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Block non-content routes from crawl budget waste.
        disallow: ["/api/", "/admin/"],
      },
    ],
    sitemap: "https://image.tinchak0207.xyz/sitemap.xml",
    host: "https://image.tinchak0207.xyz",
  };
}
