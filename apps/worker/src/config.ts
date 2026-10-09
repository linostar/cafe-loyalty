import { X509Certificate, createPrivateKey } from "node:crypto";
import { loadEnv } from "@cafe-loyalty/shared";
import { z } from "zod";

/** A PEM certificate or private key, base64-encoded on one line (kept in step with the server's config.ts). */
const base64Pem = (kind: "certificate" | "private key") =>
  z.string().transform((value, context) => {
    const pem = Buffer.from(value, "base64").toString("utf8");
    try {
      if (kind === "certificate") {
        new X509Certificate(pem);
      } else {
        createPrivateKey(pem);
      }
    } catch {
      context.addIssue({ code: "custom", message: `Use the ${kind} as PEM, base64-encoded on one line (base64 -w0).` });
      return z.NEVER;
    }
    return pem;
  });

const APPLE_KEYS = ["APPLE_PASS_TYPE_ID", "APPLE_PASS_CERTIFICATE", "APPLE_PASS_KEY"] as const;

const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    /** The app login role (a member of cl_app) on the application database, as for the server. */
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Apple Wallet, as the server has it: the pass type id is the push topic; its certificate and key sign in to APNs. */
    APPLE_PASS_TYPE_ID: z.string().regex(/^pass(\.[A-Za-z0-9-]+)+$/, "Use the pass type identifier, such as pass.com.example.loyalty.").optional(),
    APPLE_PASS_CERTIFICATE: base64Pem("certificate").optional(),
    APPLE_PASS_KEY: base64Pem("private key").optional(),
  })
  .superRefine((env, context) => {
    const missing = APPLE_KEYS.filter((key) => env[key] === undefined);
    if (missing.length > 0 && missing.length < APPLE_KEYS.length) {
      for (const key of missing) {
        context.addIssue({ code: "custom", path: [key], message: "Set every APPLE_PASS_* variable, or none (Apple Wallet off)." });
      }
    }
    if (
      env.APPLE_PASS_CERTIFICATE !== undefined &&
      env.APPLE_PASS_KEY !== undefined &&
      !new X509Certificate(env.APPLE_PASS_CERTIFICATE).checkPrivateKey(createPrivateKey(env.APPLE_PASS_KEY))
    ) {
      context.addIssue({ code: "custom", path: ["APPLE_PASS_KEY"], message: "Use the private key of APPLE_PASS_CERTIFICATE." });
    }
  })
  .transform(({ APPLE_PASS_TYPE_ID, APPLE_PASS_CERTIFICATE, APPLE_PASS_KEY, ...env }) => ({
    ...env,
    applePasses:
      APPLE_PASS_TYPE_ID === undefined || APPLE_PASS_CERTIFICATE === undefined || APPLE_PASS_KEY === undefined
        ? undefined
        : { topic: APPLE_PASS_TYPE_ID, certificate: APPLE_PASS_CERTIFICATE, privateKey: APPLE_PASS_KEY },
  }));

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function loadWorkerConfig(source: Readonly<Record<string, string | undefined>>): WorkerConfig {
  return loadEnv(workerEnvSchema, source);
}
