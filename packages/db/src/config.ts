import { loadEnv } from "@cafe-loyalty/shared";
import { z } from "zod";

const logLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const roleName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "Use lowercase letters, digits and underscores.");
const password = z
  .string()
  .min(16, "Use at least 16 characters.")
  .regex(/^[\x20-\x7e]+$/, "Use printable ASCII characters only.")
  .refine((value) => !value.startsWith("choose-a-"), "Replace the placeholder from .env.example with a real password.");

const bootstrapEnvSchema = z.object({
  LOG_LEVEL: logLevel,
  DATABASE_ADMIN_URL: postgresUrl,
  DATABASE_NAME: roleName,
  MIGRATOR_ROLE: roleName,
  MIGRATOR_PASSWORD: password,
  APP_ROLE: roleName,
  APP_PASSWORD: password,
});

const migrateEnvSchema = z.object({
  LOG_LEVEL: logLevel,
  MIGRATOR_DATABASE_URL: postgresUrl,
});

const checkEnvSchema = z.object({
  /** When set (CI on pull requests), migrations that exist on this ref must be unchanged. */
  MIGRATIONS_BASE_REF: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use a branch or ref name such as origin/main.")
    .optional(),
});

export type BootstrapEnv = z.output<typeof bootstrapEnvSchema>;
export type MigrateEnv = z.output<typeof migrateEnvSchema>;
export type CheckEnv = z.output<typeof checkEnvSchema>;

type Source = Readonly<Record<string, string | undefined>>;

export const loadBootstrapEnv = (source: Source): BootstrapEnv => loadEnv(bootstrapEnvSchema, source);
export const loadMigrateEnv = (source: Source): MigrateEnv => loadEnv(migrateEnvSchema, source);
/** Empty strings count as unset, since CI passes an empty value on non-pull-request runs. */
export const loadCheckEnv = (source: Source): CheckEnv =>
  loadEnv(checkEnvSchema, { MIGRATIONS_BASE_REF: source.MIGRATIONS_BASE_REF === "" ? undefined : source.MIGRATIONS_BASE_REF });
