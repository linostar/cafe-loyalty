import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
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

/** Writes sw.js next to the build: the service worker template with this build's cache name and files to keep offline. */
function counterServiceWorker(): Plugin {
  return {
    name: "counter-service-worker",
    apply: "build",
    async writeBundle(options, bundle) {
      const files = Object.keys(bundle).map((file) => `/${file}`);
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
    plugins: [react(), counterServiceWorker()],
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __BUILT_AT__: JSON.stringify(builtAt),
    },
    ...(proxy === undefined || proxy === "" ? {} : { server: { proxy: { "/api": proxy } } }),
  };
});
