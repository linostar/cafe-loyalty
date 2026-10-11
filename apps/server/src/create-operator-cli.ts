import { parseArgs } from "node:util";
import { createDatabase } from "@cafe-loyalty/db";
import { formatStartupFailure, loadEnv, ownerEmailSchema, redactLogObject } from "@cafe-loyalty/shared";
import { z } from "zod";
import { dashboardUrlSchema } from "./config.js";
import { setOperatorPassword } from "./operators.js";

const USAGE = "Usage: create-operator --email you@example.com   (a new operator, or a new password for an existing one)";

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DASHBOARD_URL: dashboardUrlSchema,
});

let env: z.output<typeof envSchema>;
let email: string;
try {
  env = loadEnv(envSchema, process.env);
  const { values } = parseArgs({ args: process.argv.slice(2), options: { email: { type: "string" } }, strict: true });
  const parsed = ownerEmailSchema.safeParse(values.email ?? "");
  if (!parsed.success) {
    process.stderr.write(`Give --email with an email address in Latin letters.\n${USAGE}\n`);
    process.exit(2);
  }
  email = parsed.data;
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "create-operator")}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const database = createDatabase({
  connectionString: env.DATABASE_URL,
  applicationName: "cafe-loyalty-create-operator",
  maxConnections: 1,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 10_000,
  idleTimeoutMs: 1_000,
  onPoolError: (error) => {
    process.stderr.write(`${JSON.stringify({ level: "error", service: "create-operator", msg: "database pool error", ...redactLogObject({ err: error }) })}\n`);
  },
});

let exitCode = 0;
try {
  const result = await setOperatorPassword(database.db, email);
  // The password is the operator's alone: printed once, never logged or stored.
  process.stdout.write(
    `${result.created ? "Operator created" : "New password set; every session of this operator has ended"}.\n` +
      `Sign in at ${new URL("/admin", env.DASHBOARD_URL).toString()} with ${email} and this password (shown once):\n${result.password}\n`,
  );
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: "fatal", service: "create-operator", msg: "setting the operator's password failed; run it again", ...redactLogObject({ err: error }) })}\n`);
  exitCode = 1;
} finally {
  await database.close();
}
process.exit(exitCode);
