import { base64PemSchema, googleIssuerIdSchema, googleServiceAccountSchema, keyFitsCertificate, keyringSchema } from "@cafe-loyalty/db";
import { loadEnv } from "@cafe-loyalty/shared";
import { z } from "zod";

const APPLE_KEYS = ["APPLE_PASS_TYPE_ID", "APPLE_PASS_CERTIFICATE", "APPLE_PASS_KEY"] as const;
const GOOGLE_KEYS = ["GOOGLE_WALLET_ISSUER_ID", "GOOGLE_WALLET_SERVICE_ACCOUNT", "CARD_QR_KEYS", "PUBLIC_URL"] as const;

const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
    // Running jobs get what is left after a statement on each pool (5 s each) and a second: at least 12 s.
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(12_000, "Use at least 12000 (12 seconds).").default(15_000),
    /** The app login role (a member of cl_app) on the application database, as for the server. */
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Apple Wallet, as the server has it: the pass type id is the push topic; its certificate and key sign in to APNs. */
    APPLE_PASS_TYPE_ID: z.string().regex(/^pass(\.[A-Za-z0-9-]+)+$/, "Use the pass type identifier, such as pass.com.example.loyalty.").optional(),
    APPLE_PASS_CERTIFICATE: base64PemSchema("certificate").optional(),
    APPLE_PASS_KEY: base64PemSchema("private key").optional(),
    /**
     * Google Wallet, as the server has it, plus what the worker needs to build objects as the server does: the card
     * QR keys (the object carries the card's QR) and the server's PUBLIC_URL (where Google fetches the logo).
     */
    GOOGLE_WALLET_ISSUER_ID: googleIssuerIdSchema.optional(),
    GOOGLE_WALLET_SERVICE_ACCOUNT: googleServiceAccountSchema.optional(),
    CARD_QR_KEYS: keyringSchema.optional(),
    PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  })
  .superRefine((env, context) => {
    const missing = APPLE_KEYS.filter((key) => env[key] === undefined);
    if (missing.length > 0 && missing.length < APPLE_KEYS.length) {
      for (const key of missing) {
        context.addIssue({ code: "custom", path: [key], message: "Set every APPLE_PASS_* variable, or none (Apple Wallet off)." });
      }
    }
    const missingGoogle = GOOGLE_KEYS.filter((key) => env[key] === undefined);
    if (missingGoogle.length > 0 && missingGoogle.length < GOOGLE_KEYS.length) {
      for (const key of missingGoogle) {
        context.addIssue({ code: "custom", path: [key], message: "Set GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SERVICE_ACCOUNT, CARD_QR_KEYS and PUBLIC_URL, or none (Google Wallet off)." });
      }
    }
    if (
      env.APPLE_PASS_CERTIFICATE !== undefined &&
      env.APPLE_PASS_KEY !== undefined &&
      !keyFitsCertificate(env.APPLE_PASS_CERTIFICATE, env.APPLE_PASS_KEY)
    ) {
      context.addIssue({ code: "custom", path: ["APPLE_PASS_KEY"], message: "Use the private key of APPLE_PASS_CERTIFICATE." });
    }
  })
  .transform(({ APPLE_PASS_TYPE_ID, APPLE_PASS_CERTIFICATE, APPLE_PASS_KEY, GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SERVICE_ACCOUNT, CARD_QR_KEYS, PUBLIC_URL, ...env }) => ({
    ...env,
    googlePasses:
      GOOGLE_WALLET_ISSUER_ID === undefined || GOOGLE_WALLET_SERVICE_ACCOUNT === undefined || CARD_QR_KEYS === undefined || PUBLIC_URL === undefined
        ? undefined
        : { serviceAccount: GOOGLE_WALLET_SERVICE_ACCOUNT, settings: { issuerId: GOOGLE_WALLET_ISSUER_ID, publicUrl: PUBLIC_URL, cardQr: { keys: CARD_QR_KEYS } } },
    applePasses:
      APPLE_PASS_TYPE_ID === undefined || APPLE_PASS_CERTIFICATE === undefined || APPLE_PASS_KEY === undefined
        ? undefined
        : { topic: APPLE_PASS_TYPE_ID, certificate: APPLE_PASS_CERTIFICATE, privateKey: APPLE_PASS_KEY },
  }));

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function loadWorkerConfig(source: Readonly<Record<string, string | undefined>>): WorkerConfig {
  return loadEnv(workerEnvSchema, source);
}
