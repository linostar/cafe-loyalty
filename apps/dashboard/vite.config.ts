import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { tokenValue } from "@cafe-loyalty/ui";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The product's name and the top bar's colour in index.html, from their one definitions (shared, ui tokens). */
function brandHtml(): Plugin {
  return {
    name: "brand-html",
    transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", PRODUCT_NAME).replaceAll("%THEME_COLOR%", tokenValue("color-espresso")),
  };
}

/**
 * DASHBOARD_API_PROXY, from the environment or the repo's .env, points the dev server's /api at a local API server.
 * Read on its own: Vite's loadEnv would also take the server's NODE_ENV from .env and turn builds into development builds.
 */
function apiProxy(): string | undefined {
  const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
  return process.env.DASHBOARD_API_PROXY ?? (existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")).DASHBOARD_API_PROXY : undefined);
}

export default defineConfig(() => {
  const proxy = apiProxy();
  return {
    plugins: [react(), brandHtml()],
    define: {
      __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? "dev"),
    },
    ...(proxy === undefined || proxy === "" ? {} : { server: { proxy: { "/api": proxy } } }),
  };
});
