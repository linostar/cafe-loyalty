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
export const publicUrlSchema = originSchema("customer pages", "https://card.example.com");

/** A 32-byte secret in base64. */
const secretBytes = (name: string) =>
  z.string().refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length >= 32, `Use at least 32 random bytes in base64 (${name}).`);

/**
 * A keyring: comma-separated `id:base64key` entries of 32-byte keys, the newest (used for new data) first. Older
 * keys stay listed while data made with them may still exist.
 */
const keyringSchema = z
  .string()
  .transform((value, context) => {
    const keys = value.split(",").map((entry) => {
      const [id = "", key = ""] = entry.trim().split(":");
      return { id, key: Buffer.from(key, "base64") };
    });
    const valid =
      keys.length > 0 &&
      keys.every((entry) => /^[a-z0-9]{1,16}$/.test(entry.id) && entry.key.length === 32) &&
      new Set(keys.map((entry) => entry.id)).size === keys.length;
    if (!valid) {
      context.addIssue({ code: "custom", message: "Use comma-separated id:key entries: ids of 1 to 16 lower-case letters or digits, each key 32 bytes in base64, newest first." });
      return z.NEVER;
    }
    return keys;
  });
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
  /** Public address of this server's customer pages: café signup QR codes, web cards and recovery links. */
  PUBLIC_URL: publicUrlSchema,
  /** Secret pepper for the HMAC lookup hashes of phone numbers and recovery emails (AC 6). Never change it. */
  PHONE_LOOKUP_PEPPER: secretBytes("PHONE_LOOKUP_PEPPER"),
  /** AES-256-GCM keys for phone numbers at rest. */
  PHONE_ENCRYPTION_KEYS: keyringSchema,
  /** HMAC-SHA256 keys that sign card QR codes (AC 7). */
  CARD_QR_KEYS: keyringSchema,
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
    for (const key of ["DASHBOARD_URL", "COUNTER_URL", "PUBLIC_URL"] as const) {
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
