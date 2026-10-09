import { loadEnv } from "@cafe-loyalty/shared";
import { z } from "zod";

const flag = z.enum(["true", "false"]).transform((value) => value === "true");

/** A web app's origin. Links are built as paths on it (`/signup`, `/pair`), so it must have no path of its own. */
const originSchema = (app: string, example: string) =>
  z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = new URL(value);
    return url.pathname === "/" && url.search === "" && url.hash === "";
  }, `Use the ${app}'s address without a path, such as ${example}.`);

export const dashboardUrlSchema = originSchema("dashboard", "https://dashboard.example.com");
export const counterUrlSchema = originSchema("counter app", "https://counter.example.com");

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
  // At least 10 s: an email in flight may take up to 8 s (EMAIL_SEND_TIMEOUT_MS) and shutdown waits for it.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(10_000, "Use at least 10000 (10 seconds).").default(10_000),
  /** The app login role (a member of cl_app) on the application database. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  /** Public address of the owner dashboard, used in emailed links. */
  DASHBOARD_URL: dashboardUrlSchema,
  /** Public address of the counter app; pairing QR codes open its /pair page. */
  COUNTER_URL: counterUrlSchema,
  /**
   * Number of reverse proxies in front of the server (Caddy: 1), so rate limits see the client's address.
   * Required in production: left at 0 behind a proxy, every client would share the proxy's rate limits.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  /** true for implicit TLS (port 465); false upgrades with STARTTLS, which is then required. */
  SMTP_SECURE: flag,
  /** SMTP login; leave both unset only for a local mail catcher (not allowed in production). */
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  /** Sender, for example `Cafe Loyalty <no-reply@example.com>`. */
  EMAIL_FROM: z
    .string()
    .regex(/^(?:[^<>]*<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)$/, "Use an address, such as Cafe Loyalty <no-reply@example.com>."),
})
  .superRefine((env, context) => {
    if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
      context.addIssue({ code: "custom", path: ["SMTP_PASSWORD"], message: "Set both SMTP_USER and SMTP_PASSWORD, or neither." });
    }
    if (env.NODE_ENV !== "production") {
      return;
    }
    if (env.SMTP_USER === undefined) {
      context.addIssue({ code: "custom", path: ["SMTP_USER"], message: "Set an SMTP login in production." });
    }
    if (env.TRUST_PROXY_HOPS === undefined) {
      context.addIssue({ code: "custom", path: ["TRUST_PROXY_HOPS"], message: "Set it in production (1 behind Caddy)." });
    }
    for (const key of ["DASHBOARD_URL", "COUNTER_URL"] as const) {
      if (new URL(env[key]).protocol !== "https:") {
        context.addIssue({ code: "custom", path: [key], message: "Use an https address in production." });
      }
    }
  })
  .transform((env) => ({ ...env, TRUST_PROXY_HOPS: env.TRUST_PROXY_HOPS ?? 0 }));

export type ServerConfig = z.output<typeof serverEnvSchema>;

export function loadServerConfig(source: Readonly<Record<string, string | undefined>>): ServerConfig {
  return loadEnv(serverEnvSchema, source);
}
