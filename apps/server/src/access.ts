import { withCafe, withLookup, type Database } from "@cafe-loyalty/db";
import { ApiError } from "@cafe-loyalty/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql, type Kysely } from "kysely";
import { clearedSessionCookie, hashToken, readSessionCookie } from "./credentials.js";
import { now, secondsAgo } from "./db-helpers.js";

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;
/** A session ends after this long without a request (AC 15). */
export const SESSION_IDLE_TIMEOUT_SECONDS = 7 * DAY;
/** A session ends this long after sign-in however much it is used (AC 15). */
export const SESSION_ABSOLUTE_TIMEOUT_SECONDS = 30 * DAY;
/** Last-seen times of sessions and devices are written at most this often. */
const TOUCH_SECONDS = MINUTE;

/**
 * Who may call a route: the signed-in owner (session cookie), a paired device (bearer token) or anyone.
 * Every route under /api declares one, and startup fails if one does not.
 */
export type RouteAccess = "owner" | "device" | "public";

export interface OwnerContext {
  sessionId: string;
  ownerId: string;
  cafeId: string;
}

export interface DeviceContext {
  deviceId: string;
  cafeId: string;
}

declare module "fastify" {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyRequest {
    /** The signed-in owner on `owner` routes, otherwise null. */
    owner: OwnerContext | null;
    /** The calling device on `device` routes, otherwise null. */
    device: DeviceContext | null;
  }
}

const sessionEnded = () => new ApiError("UNAUTHENTICATED", "Your session has ended. Sign in again.");
/**
 * Device routes answer a missing, unknown or expired token alike with TOKEN_EXPIRED: the device renews with its
 * key, and the renewal decides between a new token, PAIRING_REQUIRED and DEVICE_REVOKED. So a device never has to
 * guess from a 401 whether to renew or pair again.
 */
const renewToken = () => new ApiError("TOKEN_EXPIRED", "This device needs a new access token. It renews itself; try again.");

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** Methods that never change anything, so they need no JSON body. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The bearer token of an Authorization header, or undefined when absent or not shaped like a token. */
export const readBearerToken = (header: string | undefined): string | undefined => BEARER.exec(header ?? "")?.[1];

export async function findSession(db: Kysely<Database>, token: string): Promise<(OwnerContext & { lastSeenAt: Date }) | undefined> {
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

export type DeviceTokenCheck = { status: "valid"; device: DeviceContext } | { status: "unknown" | "expired" | "revoked" };

/** Checks a device access token and, when valid, records the device as seen. A revoked device is reported first. */
export async function checkDeviceToken(db: Kysely<Database>, token: string): Promise<DeviceTokenCheck> {
  const tokenHash = hashToken(token);
  const found = await withLookup(db, { secretHash: tokenHash }, (trx) =>
    trx
      .selectFrom("device_tokens")
      .select(["device_id", "cafe_id", sql<boolean>`expires_at > now()`.as("live")])
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst(),
  );
  if (found === undefined) {
    return { status: "unknown" };
  }
  return withCafe(db, found.cafe_id, async (trx) => {
    const device = await trx.selectFrom("devices").select("revoked_at").where("id", "=", found.device_id).executeTakeFirst();
    // A missing device row (undefined) counts as revoked too.
    if (device?.revoked_at !== null) {
      return { status: "revoked" } as const;
    }
    if (!found.live) {
      return { status: "expired" } as const;
    }
    await trx
      .updateTable("devices")
      .set({ last_seen_at: now() })
      .where("id", "=", found.device_id)
      .where("last_seen_at", "<", secondsAgo(TOUCH_SECONDS))
      .execute();
    return { status: "valid", device: { deviceId: found.device_id, cafeId: found.cafe_id } } as const;
  });
}

export function ownerOf(request: FastifyRequest): OwnerContext {
  if (request.owner === null) {
    throw sessionEnded();
  }
  return request.owner;
}

export function deviceOf(request: FastifyRequest): DeviceContext {
  if (request.device === null) {
    throw renewToken();
  }
  return request.device;
}

/**
 * Enforces each route's declared access within the registering plugin: refuses to register a route that declares
 * none, refuses writes without a JSON body, runs the owner or device check before the body is read, and marks
 * every response no-store. An owner route called with a valid device token
 * answers 403 (AC 20); without valid credentials it answers 401.
 */
export function registerAccessControl(app: FastifyInstance, db: Kysely<Database>): void {
  async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = readSessionCookie(request.headers.cookie);
    const session = token === undefined ? undefined : await findSession(db, token);
    if (session !== undefined) {
      if (Date.now() - session.lastSeenAt.getTime() > TOUCH_SECONDS * 1000) {
        await withCafe(db, session.cafeId, (trx) =>
          trx.updateTable("owner_sessions").set({ last_seen_at: now() }).where("id", "=", session.sessionId).execute(),
        );
      }
      request.owner = { sessionId: session.sessionId, ownerId: session.ownerId, cafeId: session.cafeId };
      return;
    }
    if (token !== undefined) {
      void reply.header("set-cookie", clearedSessionCookie);
    }
    const bearer = readBearerToken(request.headers.authorization);
    if (bearer !== undefined && (await checkDeviceToken(db, bearer)).status === "valid") {
      throw new ApiError("FORBIDDEN", "Only the café owner can do this, from the dashboard.");
    }
    throw sessionEnded();
  }

  async function requireDevice(request: FastifyRequest): Promise<void> {
    const bearer = readBearerToken(request.headers.authorization);
    const check = bearer === undefined ? ({ status: "unknown" } as const) : await checkDeviceToken(db, bearer);
    switch (check.status) {
      case "valid":
        request.device = check.device;
        return;
      case "revoked":
        throw new ApiError("DEVICE_REVOKED", "The owner removed this device. Pair it again from the owner's dashboard to use it.");
      case "expired":
      case "unknown":
        throw renewToken();
    }
  }

  app.decorateRequest("owner", null);
  app.decorateRequest("device", null);
  app.addHook("onRoute", (route) => {
    const access = route.config?.access;
    if (access !== "owner" && access !== "device" && access !== "public") {
      throw new Error(`Route ${String(route.method)} ${route.url} must declare config.access ("owner", "device" or "public").`);
    }
  });
  // onRequest, before the body is read: an unauthorised caller gets 401 or 403 rather than a parsing error, and
  // costs no parsing. Every API response is private, so none may be stored by a browser or proxy.
  app.addHook("onRequest", async (request, reply) => {
    void reply.header("cache-control", "no-store");
    // Every write carries a JSON body, even an empty one ({}). A cross-site page can send a POST with no body or a
    // form body without a CORS preflight, and a sibling subdomain is "same-site", so SameSite cookies alone do not
    // stop it; it can never send application/json without a preflight, which this API never grants.
    if (!SAFE_METHODS.has(request.method) && (request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Send the request as JSON, with an empty object ({}) when there is nothing to send.");
    }
    const access = request.routeOptions.config.access;
    if (access === "owner") {
      await requireOwner(request, reply);
    } else if (access === "device") {
      await requireDevice(request);
    }
  });
}
