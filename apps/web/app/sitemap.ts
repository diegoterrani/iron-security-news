import type { MetadataRoute } from "next";
import { listAllForSitemap } from "@/lib/blog";
import { siteUrl } from "@/lib/supabase/env";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const articles = await listAllForSitemap().catch(() => []);
  return [
    { url: `${base}/pt`, changeFrequency: "daily", priority: 1 },
    { url: `${base}/en`, changeFrequency: "daily", priority: 0.9 },
    ...articles.map((a) => ({ url: `${base}/${a.lang}/${a.slug}`, lastModified: a.published_at, changeFrequency: "weekly" as const, priority: 0.7 })),
  ];
}
