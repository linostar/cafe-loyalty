import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { tokenValue } from "@cafe-loyalty/ui";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { z } from "zod";

const buildId = process.env.BUILD_ID ?? "dev";

/**
 * The release's build time (BUILT_AT, ISO 8601 UTC; CI sets it to the commit time), which the API compares with its
 * own (AC 26); the time of this build when unset. A value the API would not read fails the build, rather than shipping
 * a counter every new action of which is refused.
 */
function releaseBuiltAt(): string {
  const value = process.env.BUILT_AT;
  if (value === undefined || value === "") {
    return new Date().toISOString();
  }
  if (!z.iso.datetime({ offset: false }).safeParse(value).success) {
    throw new Error("BUILT_AT must be an ISO 8601 UTC time, such as 2026-10-09T08:00:00Z.");
  }
  return value;
}

const builtAt = releaseBuiltAt();

/** The product's name and the top bar's colour in index.html, from their one definitions (shared, ui tokens). */
function brandHtml(): Plugin {
  return {
    name: "brand-html",
    transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", PRODUCT_NAME).replaceAll("%THEME_COLOR%", tokenValue("color-espresso")),
  };
}

/** The app's icons and web app manifest, so the counter installs to a tablet's home screen with the brand. */
function counterManifest(): Plugin {
  const icons = [192, 512].map((size) => ({ size, fileName: `icon-${String(size)}.png` }));
  return {
    name: "counter-manifest",
    apply: "build",
    generateBundle() {
      for (const icon of icons) {
        this.emitFile({ type: "asset", fileName: icon.fileName, source: readFileSync(fileURLToPath(import.meta.resolve(`@cafe-loyalty/ui/${icon.fileName}`))) });
      }
      const manifest = {
        name: `${PRODUCT_NAME} Counter`,
        short_name: "Counter",
        start_url: "/",
        display: "standalone",
        background_color: tokenValue("color-page"),
        theme_color: tokenValue("color-espresso"),
        icons: icons.map((icon) => ({ src: `/${icon.fileName}`, sizes: `${String(icon.size)}x${String(icon.size)}`, type: "image/png" })),
      };
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: `${JSON.stringify(manifest, null, 2)}\n` });
    },
    transformIndexHtml: () => [
      { tag: "link", attrs: { rel: "manifest", href: "/manifest.webmanifest" }, injectTo: "head" },
      { tag: "link", attrs: { rel: "apple-touch-icon", href: "/icon-192.png" }, injectTo: "head" },
    ],
  };
}

/** Writes sw.js next to the build: the service worker template with this build's cache name and files to keep offline. */
function counterServiceWorker(): Plugin {
  return {
    name: "counter-service-worker",
    apply: "build",
    async writeBundle(options, bundle) {
      // Fonts come as woff2 and a woff fallback that no browser able to run the counter downloads: the fallback is not kept.
      const files = Object.keys(bundle)
        .filter((file) => !file.endsWith(".woff"))
        .map((file) => `/${file}`);
      const template = await readFile(fileURLToPath(new URL("sw.js", import.meta.url)), "utf8");
      const worker = template.replace('"__CACHE_NAME__"', JSON.stringify(`counter-${buildId}-${builtAt}`)).replace('["__PRECACHE__"]', JSON.stringify(files));
      await writeFile(join(options.dir ?? "dist", "sw.js"), worker);
    },
  };
}

/**
 * COUNTER_API_PROXY, from the environment or the repo's .env, points the dev server's /api at a local API server.
 * Read on its own: Vite's loadEnv would also take the server's NODE_ENV from .env and turn builds into development builds.
 */
function apiProxy(): string | undefined {
  const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
  return process.env.COUNTER_API_PROXY ?? (existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")).COUNTER_API_PROXY : undefined);
}

export default defineConfig(() => {
  const proxy = apiProxy();
  return {
    plugins: [react(), brandHtml(), counterManifest(), counterServiceWorker()],
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __BUILT_AT__: JSON.stringify(builtAt),
    },
    ...(proxy === undefined || proxy === "" ? {} : { server: { proxy: { "/api": proxy } } }),
  };
});
