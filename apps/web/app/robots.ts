import type { MetadataRoute } from "next";
import { indexable } from "@/lib/seo";
import { siteUrl } from "@/lib/supabase/env";

/** Até o lançamento (SITE_INDEXABLE=1), buscadores não indexam o site. O painel nunca é indexado. */
export default function robots(): MetadataRoute.Robots {
  if (!indexable()) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api"] }], sitemap: `${siteUrl()}/sitemap.xml` };
}
