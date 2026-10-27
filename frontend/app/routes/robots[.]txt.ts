import type { Route } from "./+types/robots[.]txt";
import { getSiteUrl } from "~/lib/site.server";

export function loader({ request }: Route.LoaderArgs) {
  const body = [
    "User-agent: *",
    "Allow: /",
    // Private / non-content pages
    "Disallow: /library",
    "Disallow: /api/",
    "Disallow: /assets/*/download",
    "",
    `Sitemap: ${getSiteUrl(request)}/sitemap.xml`,
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
