import { loadEnv } from "@cafe-loyalty/shared";
import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  HOST: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type ServerConfig = z.output<typeof serverEnvSchema>;

export function loadServerConfig(source: Readonly<Record<string, string | undefined>>): ServerConfig {
  return loadEnv(serverEnvSchema, source);
}
