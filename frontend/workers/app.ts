import { createRequestHandler } from "react-router";

// Cloudflare Worker entry: every request that isn't a static asset is rendered by React Router.
// Server code reads its settings from process.env (nodejs_compat fills it from wrangler vars and secrets).
const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

export default {
  fetch(request) {
    // One canonical host for search engines: www.rigforge.app → rigforge.app, path and query kept.
    const url = new URL(request.url);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    return requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
