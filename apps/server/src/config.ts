import { loadEnv } from "@cafe-loyalty/shared";
import { z } from "zod";

const flag = z.enum(["true", "false"]).transform((value) => value === "true");

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** The app login role (a member of cl_app) on the application database. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  /** Public address of the owner dashboard, used in emailed links. */
  DASHBOARD_URL: z.url({ protocol: /^https?$/ }),
  /**
   * Number of reverse proxies in front of the server (Caddy: 1), so rate limits see the client's address.
   * Required in production: left at 0 behind a proxy, every client would share the proxy's rate limits.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  /** true for implicit TLS (port 465); false upgrades with STARTTLS, which is then required. */
  SMTP_SECURE: flag,
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  /** Sender, for example `Cafe Loyalty <no-reply@example.com>`. */
  EMAIL_FROM: z.string().min(3),
})
  .superRefine((env, context) => {
    if (env.NODE_ENV !== "production") {
      return;
    }
    if (env.TRUST_PROXY_HOPS === undefined) {
      context.addIssue({ code: "custom", path: ["TRUST_PROXY_HOPS"], message: "Set it in production (1 behind Caddy)." });
    }
    if (!env.DASHBOARD_URL.startsWith("https://")) {
      context.addIssue({ code: "custom", path: ["DASHBOARD_URL"], message: "Use an https address in production." });
    }
  })
  .transform((env) => ({ ...env, TRUST_PROXY_HOPS: env.TRUST_PROXY_HOPS ?? 0 }));

export type ServerConfig = z.output<typeof serverEnvSchema>;

export function loadServerConfig(source: Readonly<Record<string, string | undefined>>): ServerConfig {
  return loadEnv(serverEnvSchema, source);
}
