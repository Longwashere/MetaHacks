import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Server code reads process.env (e.g. SPINE_ASSET_URL, BACKEND_URL); fill it from .env in dev
  // without overriding variables that are already set.
  for (const [name, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) process.env[name] ??= value;

  return {
    plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), reactRouter()],
    resolve: {
      tsconfigPaths: true,
    },
  };
});
