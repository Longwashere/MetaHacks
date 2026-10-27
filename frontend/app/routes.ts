import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  layout("routes/app-layout.tsx", [
    index("routes/home.tsx"),
    route("remix", "routes/remix.tsx"),
    // /explore and /explore/character, /explore/effect, … (category landing pages)
    route("explore/:category?", "routes/explore.tsx"),
    // /assets/wandering-monk and /assets/wandering-monk/walk (one indexable page per animation)
    route("assets/:assetId/:animation?", "routes/asset.tsx"),
    route("library", "routes/library.tsx"),
  ]),
  // Resource routes (no UI)
  route("sitemap.xml", "routes/sitemap[.]xml.ts"),
  route("robots.txt", "routes/robots[.]txt.ts"),
  route("assets/:assetId/download", "routes/asset-download.ts"),
  route("api/library", "routes/api.library.ts"),
  route("api/theme", "routes/api.theme.ts"),
] satisfies RouteConfig;
