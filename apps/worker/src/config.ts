import { loadEnv } from "@cafe-loyalty/shared";
import { z } from "zod";

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** The app login role (a member of cl_app) on the application database, as for the server. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type WorkerConfig = z.output<typeof workerEnvSchema>;

export function loadWorkerConfig(source: Readonly<Record<string, string | undefined>>): WorkerConfig {
  return loadEnv(workerEnvSchema, source);
}
