import { withCafe, withLookup, type AuditActorType, type Database } from "@cafe-loyalty/db";
import {
  ApiError,
  loginRequestSchema,
  passwordChangeRequestSchema,
  passwordResetCompleteRequestSchema,
  passwordResetRequestSchema,
  signupRequestSchema,
  type OwnerSession,
} from "@cafe-loyalty/shared";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import type { BackgroundTasks } from "./background.js";
import { clearedSessionCookie, hashPassword, hashToken, newToken, readSessionCookie, sessionCookie, verifyPassword } from "./credentials.js";
import { parseInput, rateLimited } from "./http-errors.js";
import type { EmailMessage, Mailer } from "./mailer.js";
import { RateLimiter, clientKey } from "./rate-limit.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A session ends after this long without a request (AC 15). */
export const SESSION_IDLE_TIMEOUT_SECONDS = 7 * DAY;
/** A session ends this long after sign-in however much it is used (AC 15). */
export const SESSION_ABSOLUTE_TIMEOUT_SECONDS = 30 * DAY;
/** A session's last-seen time is written at most this often. */
const SESSION_TOUCH_SECONDS = MINUTE;
/** A password reset link works for this long (AC 16). */
export const RESET_TOKEN_TTL_SECONDS = 30 * MINUTE;

export const RESET_REQUESTED_MESSAGE = "If an account uses this email, we sent it a link to reset the password. The link works for 30 minutes.";

export interface OwnerContext {
  sessionId: string;
  ownerId: string;
  cafeId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in owner; set by the requireOwner pre-handler, null on routes without it. */
    owner: OwnerContext | null;
  }
}

export interface OwnerAuthOptions {
  db: Kysely<Database>;
  mailer: Mailer;
  background: BackgroundTasks;
  /** Public dashboard address; reset links open its /reset-password page. */
  dashboardUrl: string;
}

const now = () => sql<Date>`now()`;
const secondsFromNow = (seconds: number) => sql<Date>`now() + make_interval(secs => ${seconds})`;
const secondsAgo = (seconds: number) => sql<Date>`now() - make_interval(secs => ${seconds})`;

const inviteExpired = () => new ApiError("LINK_EXPIRED", "This invite link has expired or was already used. Ask for a new invite.");
const resetExpired = () => new ApiError("LINK_EXPIRED", "This password reset link has expired or was already used. Request a new one.");
const sessionEnded = () => new ApiError("UNAUTHENTICATED", "Your session has ended. Sign in again.");

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const { code, constraint: violated } = error as { code?: unknown; constraint?: unknown };
  return code === "23505" && violated === constraint;
}

async function audit(trx: Transaction<Database>, cafeId: string, ownerId: string, action: string, actorType: AuditActorType = "owner"): Promise<void> {
  await trx
    .insertInto("audit_log")
    .values({ cafe_id: cafeId, actor_type: actorType, actor_id: actorType === "owner" ? ownerId : null, action, entity_type: "owner", entity_id: ownerId })
    .execute();
}

/** Creates a session for the owner (dropping their timed-out ones) and returns its token for the cookie. */
async function startSession(trx: Transaction<Database>, cafeId: string, ownerId: string): Promise<string> {
  await trx
    .deleteFrom("owner_sessions")
    .where("owner_id", "=", ownerId)
    .where((eb) => eb.or([eb("expires_at", "<=", now()), eb("last_seen_at", "<=", secondsAgo(SESSION_IDLE_TIMEOUT_SECONDS))]))
    .execute();
  const token = newToken();
  await trx
    .insertInto("owner_sessions")
    .values({ cafe_id: cafeId, owner_id: ownerId, token_hash: hashToken(token), expires_at: secondsFromNow(SESSION_ABSOLUTE_TIMEOUT_SECONDS) })
    .execute();
  return token;
}

async function loadSession(trx: Transaction<Database>, ownerId: string): Promise<OwnerSession> {
  const row = await trx
    .selectFrom("owners")
    .innerJoin("cafes", "cafes.id", "owners.cafe_id")
    .select(["owners.id as ownerId", "owners.email", "cafes.id as cafeId", "cafes.name"])
    .where("owners.id", "=", ownerId)
    .executeTakeFirstOrThrow();
  return { owner: { id: row.ownerId, email: row.email }, cafe: { id: row.cafeId, name: row.name } };
}

/**
 * Sets a new password and ends everything the old one could reach: every session and every reset link
 * (AC 15, 16). Pairing codes join this list when devices are built (Step 6).
 */
async function setPassword(trx: Transaction<Database>, cafeId: string, ownerId: string, passwordHash: string, action: string): Promise<void> {
  await trx.updateTable("owners").set({ password_hash: passwordHash, password_changed_at: now() }).where("id", "=", ownerId).execute();
  await trx.deleteFrom("owner_sessions").where("owner_id", "=", ownerId).execute();
  await trx.deleteFrom("password_reset_tokens").where("owner_id", "=", ownerId).execute();
  await audit(trx, cafeId, ownerId, action);
}

export function passwordResetEmail(to: string, link: string): EmailMessage {
  return {
    to,
    subject: "Reset your Cafe Loyalty password",
    text: [
      "Someone asked to reset the password of your Cafe Loyalty account.",
      `To choose a new password, open this link within 30 minutes: ${link}`,
      "If you did not ask for this, ignore this email. Your password stays the same.",
      "",
      "طلب أحدهم إعادة تعيين كلمة مرور حسابك في Cafe Loyalty.",
      `لاختيار كلمة مرور جديدة، افتح هذا الرابط خلال 30 دقيقة: ${link}`,
      "إذا لم تطلب ذلك، تجاهل هذه الرسالة. كلمة مرورك لن تتغير.",
    ].join("\n"),
  };
}

/** Owner accounts (AC 15, 16): register with `{ prefix: "/api/auth" }`. */
export function ownerAuthRoutes(app: FastifyInstance, options: OwnerAuthOptions, done: (error?: Error) => void): void {
  const { db, mailer, background } = options;
  const limits = {
    signupPerIp: new RateLimiter(10, HOUR * 1000),
    loginPerIp: new RateLimiter(30, 15 * MINUTE * 1000),
    // Failures only, so a correct password never uses up the budget, and per address so that someone who knows
    // an owner's email cannot lock them out from one place; the looser per-account cap bounds distributed guessing.
    loginFailuresPerAccountAndIp: new RateLimiter(10, 15 * MINUTE * 1000),
    loginFailuresPerAccount: new RateLimiter(100, HOUR * 1000),
    resetRequestPerIp: new RateLimiter(5, HOUR * 1000),
    resetRequestPerAccount: new RateLimiter(3, HOUR * 1000),
    resetCompletePerIp: new RateLimiter(10, 15 * MINUTE * 1000),
    passwordChangePerOwner: new RateLimiter(10, 15 * MINUTE * 1000),
  };

  function enforce(limiter: RateLimiter, key: string, reply: FastifyReply): void {
    const wait = limiter.hit(key);
    if (wait > 0) {
      throw rateLimited(reply, wait);
    }
  }

  async function findSession(token: string): Promise<(OwnerContext & { lastSeenAt: Date }) | undefined> {
    const tokenHash = hashToken(token);
    return withLookup(db, { secretHash: tokenHash }, (trx) =>
      trx
        .selectFrom("owner_sessions")
        .select(["id as sessionId", "owner_id as ownerId", "cafe_id as cafeId", "last_seen_at as lastSeenAt"])
        .where("token_hash", "=", tokenHash)
        .where("expires_at", ">", now())
        .where("last_seen_at", ">", secondsAgo(SESSION_IDLE_TIMEOUT_SECONDS))
        .executeTakeFirst(),
    );
  }

  async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = readSessionCookie(request.headers.cookie);
    const session = token === undefined ? undefined : await findSession(token);
    if (session === undefined) {
      if (token !== undefined) {
        void reply.header("set-cookie", clearedSessionCookie);
      }
      throw sessionEnded();
    }
    if (Date.now() - session.lastSeenAt.getTime() > SESSION_TOUCH_SECONDS * 1000) {
      await withCafe(db, session.cafeId, (trx) =>
        trx.updateTable("owner_sessions").set({ last_seen_at: now() }).where("id", "=", session.sessionId).execute(),
      );
    }
    request.owner = { sessionId: session.sessionId, ownerId: session.ownerId, cafeId: session.cafeId };
  }

  function ownerOf(request: FastifyRequest): OwnerContext {
    if (request.owner === null) {
      throw sessionEnded();
    }
    return request.owner;
  }

  async function sendPasswordReset(email: string, log: FastifyBaseLogger): Promise<void> {
    const owner = await withLookup(db, { ownerEmail: email }, (trx) =>
      trx.selectFrom("owners").select(["id", "cafe_id"]).where("email", "=", email).executeTakeFirst(),
    );
    if (owner === undefined) {
      log.info("password reset requested for an email with no account");
      return;
    }
    const token = newToken();
    await withCafe(db, owner.cafe_id, async (trx) => {
      // Only the newest link works: the row lock makes overlapping requests replace each other's link in turn.
      await trx.selectFrom("owners").select("id").where("id", "=", owner.id).forUpdate().execute();
      await trx.deleteFrom("password_reset_tokens").where("owner_id", "=", owner.id).execute();
      await trx
        .insertInto("password_reset_tokens")
        .values({ cafe_id: owner.cafe_id, owner_id: owner.id, token_hash: hashToken(token), expires_at: secondsFromNow(RESET_TOKEN_TTL_SECONDS) })
        .execute();
      await audit(trx, owner.cafe_id, owner.id, "owner.password_reset_requested", "system");
    });
    const link = new URL("/reset-password", options.dashboardUrl);
    // In the fragment, which browsers never send to a server or put in a Referer header.
    link.hash = `token=${token}`;
    try {
      await mailer.send(passwordResetEmail(email, link.toString()));
    } catch (error) {
      log.error({ err: error, cafeId: owner.cafe_id, ownerId: owner.id }, "password reset email failed");
      return;
    }
    log.info({ cafeId: owner.cafe_id, ownerId: owner.id }, "password reset email sent");
  }

  app.decorateRequest("owner", null);
  app.addHook("onRequest", (_request, reply, next) => {
    void reply.header("cache-control", "no-store");
    next();
  });

  /** Claims an operator invite: creates the owner of the invite's café and signs them in. */
  app.post("/signup", async (request, reply) => {
    enforce(limits.signupPerIp, clientKey(request.ip), reply);
    const body = parseInput(signupRequestSchema, request.body);
    const inviteHash = hashToken(body.inviteToken);
    const invite = await withLookup(db, { secretHash: inviteHash }, (trx) =>
      trx
        .selectFrom("owner_invites")
        .select(["id", "cafe_id"])
        .where("token_hash", "=", inviteHash)
        .where("used_at", "is", null)
        .where("expires_at", ">", now())
        .executeTakeFirst(),
    );
    if (invite === undefined) {
      throw inviteExpired();
    }
    const passwordHash = await hashPassword(body.password);
    let created: { token: string; session: OwnerSession };
    try {
      created = await withCafe(db, invite.cafe_id, async (trx) => {
        const claimed = await trx
          .updateTable("owner_invites")
          .set({ used_at: now() })
          .where("id", "=", invite.id)
          .where("used_at", "is", null)
          .where("expires_at", ">", now())
          .executeTakeFirst();
        if (claimed.numUpdatedRows === 0n) {
          throw inviteExpired();
        }
        const owner = await trx
          .insertInto("owners")
          .values({ cafe_id: invite.cafe_id, email: body.email, password_hash: passwordHash })
          .returning("id")
          .executeTakeFirstOrThrow();
        await audit(trx, invite.cafe_id, owner.id, "owner.signed_up");
        const token = await startSession(trx, invite.cafe_id, owner.id);
        return { token, session: await loadSession(trx, owner.id) };
      });
    } catch (error) {
      // The transaction rolled back, so the invite is still unused.
      if (isUniqueViolation(error, "owners_email_key")) {
        throw new ApiError("CONFLICT", "This email already has an account. Sign in instead, or use another email.");
      }
      throw error;
    }
    request.log.info({ cafeId: invite.cafe_id, ownerId: created.session.owner.id }, "owner signed up");
    return reply.code(201).header("set-cookie", sessionCookie(created.token, SESSION_ABSOLUTE_TIMEOUT_SECONDS)).send(created.session);
  });

  app.post("/login", async (request, reply) => {
    const client = clientKey(request.ip);
    enforce(limits.loginPerIp, client, reply);
    const body = parseInput(loginRequestSchema, request.body);
    const accountAndClient = `${body.email} ${client}`;
    const wait = Math.max(limits.loginFailuresPerAccountAndIp.check(accountAndClient), limits.loginFailuresPerAccount.check(body.email));
    if (wait > 0) {
      // A refused attempt is not counted, so it cannot push the account's overall cap.
      throw rateLimited(reply, wait);
    }
    // Counted now as a failure and refunded if the password is right: counting only after the slow check would let
    // parallel requests all pass the check above.
    limits.loginFailuresPerAccountAndIp.hit(accountAndClient);
    limits.loginFailuresPerAccount.hit(body.email);
    const owner = await withLookup(db, { ownerEmail: body.email }, (trx) =>
      trx.selectFrom("owners").select(["id", "cafe_id", "password_hash"]).where("email", "=", body.email).executeTakeFirst(),
    );
    const valid = await verifyPassword(owner?.password_hash, body.password);
    if (owner === undefined || !valid) {
      request.log.info({ cafeId: owner?.cafe_id ?? null }, "owner sign-in failed");
      throw new ApiError("UNAUTHENTICATED", "The email or password is wrong. Try again, or reset your password.");
    }
    limits.loginFailuresPerAccountAndIp.refund(accountAndClient);
    limits.loginFailuresPerAccount.refund(body.email);
    const created = await withCafe(db, owner.cafe_id, async (trx) => {
      // The hash was checked outside this transaction. Locking the owner row and comparing again orders this
      // sign-in against a concurrent password change or reset, so no session made with the old password outlives it.
      const current = await trx.selectFrom("owners").select("password_hash").where("id", "=", owner.id).forShare().executeTakeFirst();
      if (current?.password_hash !== owner.password_hash) {
        throw new ApiError("UNAUTHENTICATED", "The email or password is wrong. Try again, or reset your password.");
      }
      const token = await startSession(trx, owner.cafe_id, owner.id);
      await audit(trx, owner.cafe_id, owner.id, "owner.signed_in");
      return { token, session: await loadSession(trx, owner.id) };
    });
    request.log.info({ cafeId: owner.cafe_id, ownerId: owner.id }, "owner signed in");
    return reply.header("set-cookie", sessionCookie(created.token, SESSION_ABSOLUTE_TIMEOUT_SECONDS)).send(created.session);
  });

  app.get("/session", { preHandler: requireOwner }, async (request) => {
    const owner = ownerOf(request);
    return withCafe(db, owner.cafeId, (trx) => loadSession(trx, owner.ownerId));
  });

  /** Ends every session of the owner, not only this one (AC 15). Always clears the cookie. */
  app.post("/logout", async (request, reply) => {
    const token = readSessionCookie(request.headers.cookie);
    const session = token === undefined ? undefined : await findSession(token);
    if (session !== undefined) {
      await withCafe(db, session.cafeId, async (trx) => {
        await trx.deleteFrom("owner_sessions").where("owner_id", "=", session.ownerId).execute();
        await audit(trx, session.cafeId, session.ownerId, "owner.signed_out");
      });
      request.log.info({ cafeId: session.cafeId, ownerId: session.ownerId }, "owner signed out");
    }
    return reply.code(204).header("set-cookie", clearedSessionCookie).send();
  });

  /** Changes the password and ends every session, this one included (AC 15). */
  app.post("/password", { preHandler: requireOwner }, async (request, reply) => {
    const owner = ownerOf(request);
    enforce(limits.passwordChangePerOwner, owner.ownerId, reply);
    const body = parseInput(passwordChangeRequestSchema, request.body);
    const current = await withCafe(db, owner.cafeId, (trx) =>
      trx.selectFrom("owners").select("password_hash").where("id", "=", owner.ownerId).executeTakeFirstOrThrow(),
    );
    if (!(await verifyPassword(current.password_hash, body.currentPassword))) {
      throw new ApiError("VALIDATION_FAILED", "The current password is wrong.", [{ path: "currentPassword", issue: "The current password is wrong." }]);
    }
    const passwordHash = await hashPassword(body.newPassword);
    await withCafe(db, owner.cafeId, (trx) => setPassword(trx, owner.cafeId, owner.ownerId, passwordHash, "owner.password_changed"));
    request.log.info({ cafeId: owner.cafeId, ownerId: owner.ownerId }, "owner password changed");
    return reply.code(204).header("set-cookie", clearedSessionCookie).send();
  });

  /**
   * Starts a password reset. The reply is the same whether or not the email has an account, and it is sent
   * before any lookup, so its timing cannot tell either (AC 16); the lookup and the email run afterwards.
   */
  app.post("/password-reset", async (request, reply) => {
    enforce(limits.resetRequestPerIp, clientKey(request.ip), reply);
    const body = parseInput(passwordResetRequestSchema, request.body);
    enforce(limits.resetRequestPerAccount, body.email, reply);
    const log = request.log;
    background.run("password-reset-email", () => sendPasswordReset(body.email, log));
    return reply.code(202).send({ message: RESET_REQUESTED_MESSAGE });
  });

  /** Sets a new password from a reset link: single-use, and it ends every session (AC 16). */
  app.post("/password-reset/complete", async (request, reply) => {
    enforce(limits.resetCompletePerIp, clientKey(request.ip), reply);
    const body = parseInput(passwordResetCompleteRequestSchema, request.body);
    const tokenHash = hashToken(body.token);
    const reset = await withLookup(db, { secretHash: tokenHash }, (trx) =>
      trx
        .selectFrom("password_reset_tokens")
        .select(["id", "cafe_id", "owner_id"])
        .where("token_hash", "=", tokenHash)
        .where("expires_at", ">", now())
        .executeTakeFirst(),
    );
    if (reset === undefined) {
      throw resetExpired();
    }
    const passwordHash = await hashPassword(body.password);
    await withCafe(db, reset.cafe_id, async (trx) => {
      const used = await trx.deleteFrom("password_reset_tokens").where("id", "=", reset.id).where("expires_at", ">", now()).executeTakeFirst();
      if (used.numDeletedRows === 0n) {
        throw resetExpired();
      }
      await setPassword(trx, reset.cafe_id, reset.owner_id, passwordHash, "owner.password_reset");
    });
    request.log.info({ cafeId: reset.cafe_id, ownerId: reset.owner_id }, "owner password reset");
    return reply.code(204).send();
  });

  done();
}
