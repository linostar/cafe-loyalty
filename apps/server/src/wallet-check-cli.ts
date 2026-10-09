import { createDatabase, createJobQueue, startJobQueue } from "@cafe-loyalty/db";
import { formatStartupFailure, loadEnv, redactLogObject } from "@cafe-loyalty/shared";
import { z } from "zod";
import { publicUrlSchema } from "./config.js";
import { WALLET_CHECK_USAGE, parseWalletCheckArgs, runWalletCheck, type WalletCheckCommand } from "./wallet-check.js";

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PUBLIC_URL: publicUrlSchema,
});

const fail = (msg: string, error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: "error", service: "wallet-check", msg, ...redactLogObject({ err: error }) })}\n`);
};

let env: z.output<typeof envSchema>;
let command: WalletCheckCommand;
try {
  env = loadEnv(envSchema, process.env);
  const parsed = parseWalletCheckArgs(process.argv.slice(2));
  if (parsed === null) {
    process.stderr.write(`${WALLET_CHECK_USAGE}\n`);
    process.exit(2);
  }
  command = parsed;
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "wallet-check")}\n${WALLET_CHECK_USAGE}\n`);
  process.exit(2);
}

const database = createDatabase({
  connectionString: env.DATABASE_URL,
  applicationName: "cafe-loyalty-wallet-check",
  maxConnections: 1,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 10_000,
  idleTimeoutMs: 1_000,
  onPoolError: (error) => {
    fail("database pool error", error);
  },
});
// Send only, as the server: the worker delivers the pass updates.
const jobs = createJobQueue(env.DATABASE_URL, {
    error: (...args: unknown[]) => {
      fail("job queue error", args[0]);
    },
    warn: () => undefined,
  }, {
  applicationName: "cafe-loyalty-wallet-check",
  maxConnections: 1,
  sendOnly: true,
});

let exitCode = 0;
try {
  await startJobQueue(jobs);
  // The links are the tester's, printed and never logged.
  process.stdout.write(`${await runWalletCheck(database.db, jobs, env.PUBLIC_URL, command)}\n`);
} catch (error) {
  fail("wallet check failed", error);
  exitCode = 1;
} finally {
  await jobs.stop({ graceful: false });
  await database.close();
}
process.exit(exitCode);
