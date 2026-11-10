import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { tokenValue } from "@cafe-loyalty/ui";
import { defineConfig, type Plugin } from "vite";

/** The site's pages: the landing page and the pilot form's two answers, in English and in Arabic (`ar/`). */
const PAGES = ["index", "thanks", "sorry"].flatMap((page) => [`${page}.html`, `ar/${page}.html`]);

/**
 * The server address the pilot form posts to (the public card domain's `/pilot-request`), from PILOT_REQUEST_URL. A
 * build without it fails rather than publish a form that goes nowhere; the dev server falls back to a local server.
 */
function pilotRequestUrl(command: "build" | "serve"): string {
  const url = process.env.PILOT_REQUEST_URL;
  if (url !== undefined && url !== "") {
    if (!/^https:\/\/[^/]+\/pilot-request$/.test(url)) {
      throw new Error(`PILOT_REQUEST_URL must be https://<the public card domain>/pilot-request, not ${url}.`);
    }
    return url;
  }
  if (command === "build") {
    throw new Error("Set PILOT_REQUEST_URL (https://<the public card domain>/pilot-request) to build the landing page.");
  }
  return "http://localhost:3000/pilot-request";
}

/** The product's name, the theme colour and the form's address in every page, from their one definitions. */
function siteHtml(formAction: string): Plugin {
  return {
    name: "site-html",
    transformIndexHtml: (html) =>
      html
        .replaceAll("%PRODUCT_NAME%", PRODUCT_NAME)
        .replaceAll("%THEME_COLOR%", tokenValue("color-espresso"))
        .replaceAll("%PILOT_REQUEST_URL%", formAction)
        .replaceAll("%PILOT_REQUEST_ORIGIN%", new URL(formAction).origin),
  };
}

export default defineConfig(({ command }) => ({
  plugins: [siteHtml(pilotRequestUrl(command))],
  // Beside the dashboard (5173) and the counter (5174); the server's LANDING_URL in development.
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true },
  build: {
    rolldownOptions: { input: PAGES.map((page) => fileURLToPath(new URL(page, import.meta.url))) },
  },
}));
