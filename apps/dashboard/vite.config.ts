import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // DASHBOARD_API_PROXY (from the repo's .env) points the dev server's /api at a local API server.
  const env = loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), "");
  const apiProxy = env.DASHBOARD_API_PROXY;
  return {
    plugins: [react()],
    define: {
      __BUILD_ID__: JSON.stringify(process.env.BUILD_ID ?? "dev"),
    },
    ...(apiProxy === undefined || apiProxy === "" ? {} : { server: { proxy: { "/api": apiProxy } } }),
  };
});
