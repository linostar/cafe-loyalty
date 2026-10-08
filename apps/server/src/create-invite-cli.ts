import { createDatabase } from "@cafe-loyalty/db";
import { formatStartupFailure, loadEnv, redactLogObject } from "@cafe-loyalty/shared";
import { z } from "zod";
import { dashboardUrlSchema } from "./config.js";
import { createOwnerInvite, inviteLink, parseInviteArgs, type InviteTarget } from "./invites.js";

const USAGE = 'Usage: create-invite --cafe-name "Café name"   (new café)\n       create-invite --cafe-id <uuid>          (another owner, or a fresh link, for an existing café)';

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DASHBOARD_URL: dashboardUrlSchema,
});

let env: z.output<typeof envSchema>;
let target: InviteTarget;
try {
  env = loadEnv(envSchema, process.env);
  const parsed = parseInviteArgs(process.argv.slice(2));
  if (parsed === null) {
    process.stderr.write(`Give exactly one of --cafe-name (1 to 120 characters) or --cafe-id (a UUID).\n${USAGE}\n`);
    process.exit(2);
  }
  target = parsed;
} catch (error) {
  process.stderr.write(`${formatStartupFailure(error, "create-invite")}\n`);
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const database = createDatabase({
  connectionString: env.DATABASE_URL,
  applicationName: "cafe-loyalty-create-invite",
  maxConnections: 1,
  connectionTimeoutMs: 10_000,
  statementTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 10_000,
  idleTimeoutMs: 1_000,
  onPoolError: (error) => {
    process.stderr.write(`${JSON.stringify({ level: "error", service: "create-invite", msg: "database pool error", ...redactLogObject({ err: error }) })}\n`);
  },
});

let exitCode = 0;
try {
  const invite = await createOwnerInvite(database.db, target);
  // The link is the operator's to hand to the café owner; it is printed, never logged.
  process.stdout.write(
    `Café id: ${invite.cafeId}\nSingle-use invite link, valid until ${invite.expiresAt.toISOString()}:\n${inviteLink(env.DASHBOARD_URL, invite.token)}\n`,
  );
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: "fatal", service: "create-invite", msg: "creating the invite failed", ...redactLogObject({ err: error }) })}\n`);
  exitCode = 1;
} finally {
  await database.close();
}
process.exit(exitCode);
