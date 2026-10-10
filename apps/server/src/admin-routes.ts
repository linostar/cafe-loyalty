import { withCafe, withLookup, withOperator, type Database } from "@cafe-loyalty/db";
import {
  ADMIN_PAYMENTS_SHOWN,
  ApiError,
  cafePlanUpdateSchema,
  loginRequestSchema,
  paymentRecordSchema,
  type AdminCafe,
  type OperatorSession,
} from "@cafe-loyalty/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { OPERATOR_SESSION_ABSOLUTE_TIMEOUT_SECONDS, OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS, findOperatorSession, operatorOf } from "./access.js";
import { clearedOperatorCookie, hashToken, newToken, operatorSessionCookie, readOperatorCookie, verifyPassword } from "./credentials.js";
import { audit, now, secondsAgo, secondsFromNow } from "./db-helpers.js";
import { parseInput, rateLimited } from "./http-errors.js";
import { RateLimiter, clientKey } from "./rate-limit.js";

export interface AdminRoutesOptions {
  db: Kysely<Database>;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const idParams = z.object({ id: z.uuid("Use a café from the list.") });
const wrongCredentials = () => new ApiError("UNAUTHENTICATED", "The email or password is wrong. Try again, or ask for a new password from create-operator.");
const cafeNotFound = () => new ApiError("NOT_FOUND", "This café no longer exists. Reload the list.");

/** Creates a session for the operator (dropping their timed-out ones) and returns its token for the cookie. */
async function startSession(trx: Transaction<Database>, operatorId: string): Promise<string> {
  await trx
    .deleteFrom("operator_sessions")
    .where("operator_id", "=", operatorId)
    .where((eb) => eb.or([eb("expires_at", "<=", now()), eb("last_seen_at", "<=", secondsAgo(OPERATOR_SESSION_IDLE_TIMEOUT_SECONDS))]))
    .execute();
  const token = newToken();
  await trx
    .insertInto("operator_sessions")
    .values({ operator_id: operatorId, token_hash: hashToken(token), expires_at: secondsFromNow(OPERATOR_SESSION_ABSOLUTE_TIMEOUT_SECONDS) })
    .execute();
  return token;
}

async function loadSession(trx: Transaction<Database>, operatorId: string): Promise<OperatorSession> {
  const row = await trx.selectFrom("operators").select(["id", "email"]).where("id", "=", operatorId).executeTakeFirstOrThrow();
  return { operator: { id: row.id, email: row.email } };
}

/** A café as the admin screen shows it, read inside its withCafe; undefined when it does not exist. */
async function loadCafe(trx: Transaction<Database>, cafeId: string): Promise<AdminCafe | undefined> {
  const cafe = await trx.selectFrom("cafes").select(["id", "name", "plan", "created_at"]).where("id", "=", cafeId).executeTakeFirst();
  if (cafe === undefined) {
    return undefined;
  }
  const payments = await trx
    .selectFrom("cafe_payments")
    .select(["id", "amount_cents", sql<string>`to_char(paid_on, 'YYYY-MM-DD')`.as("paid_on"), "method", "reference", "created_at"])
    .orderBy("cafe_payments.paid_on", "desc")
    .orderBy("created_at", "desc")
    .limit(ADMIN_PAYMENTS_SHOWN)
    .execute();
  const paid = await trx.selectFrom("cafe_payments").select(sql<string>`coalesce(sum(amount_cents), 0)`.as("total")).executeTakeFirstOrThrow();
  return {
    id: cafe.id,
    name: cafe.name,
    plan: cafe.plan,
    createdAt: cafe.created_at.toISOString(),
    paidCents: Number(paid.total),
    payments: payments.map((payment) => ({
      id: payment.id,
      amountCents: payment.amount_cents,
      paidOn: payment.paid_on,
      method: payment.method,
      reference: payment.reference,
      recordedAt: payment.created_at.toISOString(),
    })),
  };
}

/** Today's date in UTC, "YYYY-MM-DD", moved by `days`. */
const utcDay = (days: number): string => new Date(Date.now() + days * 24 * HOUR * 1000).toISOString().slice(0, 10);

/**
 * The operator's admin screen (AC 39), under `/api/admin`: signing in with an operator account (made by
 * create-operator), each café's plan and the payments it made by hand. Operator routes answer 403 to owners and
 * devices. The operator may act on any café, so a café id here comes from the route, checked against the cafés that
 * exist; each café is then read and changed in its own withCafe, and every change goes in that café's audit log.
 */
export function adminRoutes(app: FastifyInstance, options: AdminRoutesOptions, done: (error?: Error) => void): void {
  const { db } = options;
  const limits = {
    loginPerIp: new RateLimiter(20, 15 * MINUTE * 1000),
    // As for owners (owner-auth.ts): failures only, per account and address, with a looser cap per account.
    loginFailuresPerAccountAndIp: new RateLimiter(5, 15 * MINUTE * 1000),
    loginFailuresPerAccount: new RateLimiter(50, HOUR * 1000),
  };

  function enforce(limiter: RateLimiter, key: string, reply: FastifyReply): void {
    const wait = limiter.hit(key);
    if (wait > 0) {
      throw rateLimited(reply, wait);
    }
  }

  /** The café of a route's id, inside withCafe; NOT_FOUND when there is none. */
  async function withListedCafe<T>(cafeId: string, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return withCafe(db, cafeId, async (trx) => {
      // Locked, so a plan change and a payment for the same café run one at a time.
      const found = await trx.selectFrom("cafes").select("id").where("id", "=", cafeId).forNoKeyUpdate().executeTakeFirst();
      if (found === undefined) {
        throw cafeNotFound();
      }
      return work(trx);
    });
  }

  app.post("/login", { config: { access: "public" } }, async (request, reply) => {
    const client = clientKey(request.ip);
    enforce(limits.loginPerIp, client, reply);
    const body = parseInput(loginRequestSchema, request.body);
    const accountAndClient = `${body.email} ${client}`;
    const wait = Math.max(limits.loginFailuresPerAccountAndIp.check(accountAndClient), limits.loginFailuresPerAccount.check(body.email));
    if (wait > 0) {
      throw rateLimited(reply, wait);
    }
    // Counted as a failure now and refunded on success, so parallel attempts cannot all pass the check above.
    limits.loginFailuresPerAccountAndIp.hit(accountAndClient);
    limits.loginFailuresPerAccount.hit(body.email);
    const operator = await withLookup(db, { operatorEmail: body.email }, (trx) =>
      trx.selectFrom("operators").select(["id", "password_hash"]).where("email", "=", body.email).executeTakeFirst(),
    );
    // Checked even for an unknown email (against a throwaway hash), so the time taken tells nothing.
    const valid = await verifyPassword(operator?.password_hash, body.password);
    if (operator === undefined || !valid) {
      request.log.info("operator sign-in failed");
      throw wrongCredentials();
    }
    limits.loginFailuresPerAccountAndIp.refund(accountAndClient);
    limits.loginFailuresPerAccount.refund(body.email);
    const created = await withOperator(db, operator.id, async (trx) => {
      // Compared again under a lock, so a password replaced by create-operator meanwhile leaves no session behind.
      const current = await trx.selectFrom("operators").select("password_hash").where("id", "=", operator.id).forShare().executeTakeFirst();
      if (current?.password_hash !== operator.password_hash) {
        throw wrongCredentials();
      }
      return { token: await startSession(trx, operator.id), session: await loadSession(trx, operator.id) };
    });
    request.log.info({ operatorId: operator.id }, "operator signed in");
    return reply.header("set-cookie", operatorSessionCookie(created.token, OPERATOR_SESSION_ABSOLUTE_TIMEOUT_SECONDS)).send(created.session);
  });

  app.get("/session", { config: { access: "operator" } }, async (request) => {
    const operator = operatorOf(request);
    return withOperator(db, operator.operatorId, (trx) => loadSession(trx, operator.operatorId));
  });

  /** Ends every session of the operator, not only this one. Always clears the cookie. */
  app.post("/logout", { config: { access: "public" } }, async (request, reply) => {
    const token = readOperatorCookie(request.headers.cookie);
    const session = token === undefined ? undefined : await findOperatorSession(db, token);
    if (session !== undefined) {
      await withOperator(db, session.operatorId, (trx) => trx.deleteFrom("operator_sessions").where("operator_id", "=", session.operatorId).execute());
      request.log.info({ operatorId: session.operatorId }, "operator signed out");
    }
    return reply.code(204).header("set-cookie", clearedOperatorCookie).send();
  });

  /** Every café, oldest first. ponytail: one withCafe per café, unpaged; fine for the pilot's few cafés, page it past a few dozen. */
  app.get("/cafes", { config: { access: "operator" } }, async () => {
    const { rows } = await sql<{ cafe_id: string }>`SELECT cafe_id FROM cafes_for_operator()`.execute(db);
    const cafes: AdminCafe[] = [];
    for (const { cafe_id: cafeId } of rows) {
      const cafe = await withCafe(db, cafeId, (trx) => loadCafe(trx, cafeId));
      if (cafe !== undefined) {
        cafes.push(cafe);
      }
    }
    return { cafes };
  });

  /** Sets a café's plan; suspending it stops new customers joining (AC 39), its counter still syncs. */
  app.patch("/cafes/:id", { config: { access: "operator" } }, async (request) => {
    const operator = operatorOf(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(cafePlanUpdateSchema, request.body);
    const cafe = await withListedCafe(id, async (trx) => {
      const before = await trx.selectFrom("cafes").select("plan").where("id", "=", id).executeTakeFirstOrThrow();
      if (before.plan !== body.plan) {
        await trx.updateTable("cafes").set({ plan: body.plan }).where("id", "=", id).execute();
        await audit(trx, { cafeId: id, actorType: "operator", actorId: operator.operatorId, action: "cafe.plan_changed", entityType: "cafe", entityId: id, changes: { from: before.plan, to: body.plan } });
      }
      return loadCafe(trx, id);
    });
    request.log.info({ cafeId: id, operatorId: operator.operatorId, plan: body.plan }, "cafe plan set");
    return cafe;
  });

  /** Records a payment the café made by hand (AC 39). Payments are never changed or deleted. */
  app.post("/cafes/:id/payments", { config: { access: "operator" } }, async (request, reply) => {
    const operator = operatorOf(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(paymentRecordSchema, request.body);
    // A day either side of UTC covers every time zone; the service started in 2026.
    if (body.paidOn > utcDay(1) || body.paidOn < "2026-01-01") {
      throw new ApiError("VALIDATION_FAILED", "Use the day the café paid, from 2026 up to today.", [{ path: "paidOn", issue: "Use the day the café paid, from 2026 up to today." }]);
    }
    const cafe = await withListedCafe(id, async (trx) => {
      const payment = await trx
        .insertInto("cafe_payments")
        .values({ cafe_id: id, amount_cents: body.amountCents, paid_on: body.paidOn, method: body.method, reference: body.reference, operator_id: operator.operatorId })
        .returning("id")
        .executeTakeFirstOrThrow();
      await audit(trx, {
        cafeId: id,
        actorType: "operator",
        actorId: operator.operatorId,
        action: "cafe.payment_recorded",
        entityType: "cafe_payment",
        entityId: payment.id,
        changes: { amountCents: body.amountCents, paidOn: body.paidOn, method: body.method },
      });
      return loadCafe(trx, id);
    });
    request.log.info({ cafeId: id, operatorId: operator.operatorId }, "cafe payment recorded");
    return reply.code(201).send(cafe);
  });

  done();
}
