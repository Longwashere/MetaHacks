// Canonical origin for absolute URLs (canonical tags, Open Graph, sitemap).
// Set PUBLIC_SITE_URL in production (e.g. https://rigforge.app) so URLs don't
// depend on the Host header behind proxies/CDNs.
export function getSiteUrl(request: Request) {
  const fromEnv = process.env.PUBLIC_SITE_URL?.replace(/\/$/, "");
  return fromEnv || new URL(request.url).origin;
}
