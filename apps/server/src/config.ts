import { base64PemSchema, googleIssuerIdSchema, googleServiceAccountSchema, keyFitsCertificate, keyringSchema } from "@cafe-loyalty/db";
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

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A 32-byte secret in base64. */
const secretBytes = (name: string) =>
  z.string().refine((value) => BASE64.test(value) && Buffer.from(value, "base64").length >= 32, `Use at least 32 random bytes in base64 (${name}).`);

export const counterUrlSchema = originSchema("counter app", "https://counter.example.com");

const APPLE_KEYS = ["APPLE_PASS_TYPE_ID", "APPLE_TEAM_ID", "APPLE_PASS_CERTIFICATE", "APPLE_PASS_KEY", "APPLE_WWDR_CERTIFICATE"] as const;

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
   * When this release was built (ISO 8601 UTC, the commit time), the same value its counter build carries. Counter
   * builds made more than COUNTER_SUPPORT_DAYS earlier get CLIENT_TOO_OLD for new actions (AC 26). Required in
   * production; elsewhere it defaults to the server's start time.
   */
  BUILT_AT: z.iso.datetime({ offset: false }).optional(),
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
  /**
   * Apple Wallet (AC 10, 11): all five, or none for no Apple passes. The pass type identifier and team id from the
   * Apple developer account, the pass type certificate and its key (which also sign the worker in to APNs), and
   * Apple's WWDR intermediate certificate, each PEM base64-encoded on one line.
   */
  APPLE_PASS_TYPE_ID: z.string().regex(/^pass(\.[A-Za-z0-9-]+)+$/, "Use the pass type identifier, such as pass.com.example.loyalty.").optional(),
  APPLE_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/, "Use the 10-character team id of the Apple developer account.").optional(),
  APPLE_PASS_CERTIFICATE: base64PemSchema("certificate").optional(),
  APPLE_PASS_KEY: base64PemSchema("private key").optional(),
  APPLE_WWDR_CERTIFICATE: base64PemSchema("certificate").optional(),
  /**
   * Google Wallet (AC 10): both, or neither for no Google passes. The issuer id from the Google Pay & Wallet Console,
   * and the JSON key file of the service account the issuer account added as a user, base64-encoded on one line.
   */
  GOOGLE_WALLET_ISSUER_ID: googleIssuerIdSchema.optional(),
  GOOGLE_WALLET_SERVICE_ACCOUNT: googleServiceAccountSchema.optional(),
})
  .superRefine((env, context) => {
    const missingApple = APPLE_KEYS.filter((key) => env[key] === undefined);
    if (missingApple.length > 0 && missingApple.length < APPLE_KEYS.length) {
      for (const key of missingApple) {
        context.addIssue({ code: "custom", path: [key], message: "Set every Apple Wallet variable (APPLE_*), or none (Apple Wallet off)." });
      }
    }
    if (
      env.APPLE_PASS_CERTIFICATE !== undefined &&
      env.APPLE_PASS_KEY !== undefined &&
      !keyFitsCertificate(env.APPLE_PASS_CERTIFICATE, env.APPLE_PASS_KEY)
    ) {
      context.addIssue({ code: "custom", path: ["APPLE_PASS_KEY"], message: "Use the private key of APPLE_PASS_CERTIFICATE." });
    }
    if ((env.GOOGLE_WALLET_ISSUER_ID === undefined) !== (env.GOOGLE_WALLET_SERVICE_ACCOUNT === undefined)) {
      const missing = env.GOOGLE_WALLET_ISSUER_ID === undefined ? "GOOGLE_WALLET_ISSUER_ID" : "GOOGLE_WALLET_SERVICE_ACCOUNT";
      context.addIssue({ code: "custom", path: [missing], message: "Set both Google Wallet variables (GOOGLE_WALLET_*), or neither (Google Wallet off)." });
    }
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
    if (env.BUILT_AT === undefined) {
      context.addIssue({ code: "custom", path: ["BUILT_AT"], message: "Set it in production to the release's build time, as the counter build has it." });
    }
    for (const key of ["DASHBOARD_URL", "COUNTER_URL", "PUBLIC_URL"] as const) {
      if (new URL(env[key]).protocol !== "https:") {
        context.addIssue({ code: "custom", path: [key], message: "Use an https address in production." });
      }
    }
  })
  .transform(({ APPLE_PASS_TYPE_ID, APPLE_TEAM_ID, APPLE_PASS_CERTIFICATE, APPLE_PASS_KEY, APPLE_WWDR_CERTIFICATE, GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SERVICE_ACCOUNT, ...env }) => ({
    ...env,
    googlePasses:
      GOOGLE_WALLET_ISSUER_ID === undefined || GOOGLE_WALLET_SERVICE_ACCOUNT === undefined
        ? undefined
        : { issuerId: GOOGLE_WALLET_ISSUER_ID, serviceAccount: GOOGLE_WALLET_SERVICE_ACCOUNT },
    TRUST_PROXY_HOPS: env.TRUST_PROXY_HOPS ?? 0,
    BUILT_AT: env.BUILT_AT === undefined ? new Date() : new Date(env.BUILT_AT),
    applePasses:
      APPLE_PASS_TYPE_ID === undefined || APPLE_TEAM_ID === undefined || APPLE_PASS_CERTIFICATE === undefined || APPLE_PASS_KEY === undefined || APPLE_WWDR_CERTIFICATE === undefined
        ? undefined
        : {
            passTypeId: APPLE_PASS_TYPE_ID,
            teamId: APPLE_TEAM_ID,
            certificates: { signerCert: APPLE_PASS_CERTIFICATE, signerKey: APPLE_PASS_KEY, wwdr: APPLE_WWDR_CERTIFICATE },
          },
  }));

export type ServerConfig = z.output<typeof serverEnvSchema>;

export function loadServerConfig(source: Readonly<Record<string, string | undefined>>): ServerConfig {
  return loadEnv(serverEnvSchema, source);
}
