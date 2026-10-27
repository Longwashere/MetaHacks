import type { Route } from "./+types/sitemap[.]xml";
import { listAssets } from "~/lib/api.server";
import { assetPath } from "~/lib/seo";
import { getSiteUrl } from "~/lib/site.server";
import { ASSET_CATEGORIES } from "~/lib/types";

// BACKEND: past ~50k URLs, split into a sitemap index (/sitemap.xml → /sitemaps/assets-1.xml, …).
export async function loader({ request }: Route.LoaderArgs) {
  const site = getSiteUrl(request);
  const assets = await listAssets({ sort: "newest" });

  const urls: { loc: string; lastmod?: string }[] = [
    { loc: `${site}/` },
    { loc: `${site}/explore` },
    { loc: `${site}/remix` },
    ...ASSET_CATEGORIES.map((c) => ({ loc: `${site}/explore/${c}` })),
    ...assets.flatMap((asset) => [
      { loc: `${site}${assetPath(asset)}`, lastmod: asset.createdAt },
      ...asset.animations.map((a) => ({ loc: `${site}${assetPath(asset, a.name)}`, lastmod: asset.createdAt })),
    ]),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ""}</url>`)
  .join("\n")}
</urlset>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}

function escapeXml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
