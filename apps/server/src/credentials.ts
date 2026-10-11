import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

/** A new random secret: 32 bytes (256 bits) in base64url, 43 characters. */
export const newToken = (): string => randomBytes(32).toString("base64url");

/** What the database stores for a secret: its SHA-256 hash, so a database leak exposes no usable token. */
export const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** `__Host-` makes the browser require Secure and Path=/ and refuse a Domain, so no subdomain can set or read it. */
export const SESSION_COOKIE = "__Host-cl_session";

const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Strict";

/** The operator's session (AC 39): its own cookie, so an owner session and an operator session never stand for each other. */
export const OPERATOR_SESSION_COOKIE = "__Host-cl_operator";

/** A cookie's token from a Cookie header, or undefined when absent or not shaped like a token. */
function readTokenCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return TOKEN_FORMAT.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/** The owner's session token from a Cookie header, or undefined when absent or not shaped like a token. */
export const readSessionCookie = (header: string | undefined): string | undefined => readTokenCookie(header, SESSION_COOKIE);
/** The operator's session token from a Cookie header, likewise. */
export const readOperatorCookie = (header: string | undefined): string | undefined => readTokenCookie(header, OPERATOR_SESSION_COOKIE);

export const sessionCookie = (token: string, maxAgeSeconds: number): string =>
  `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${String(maxAgeSeconds)}`;

export const clearedSessionCookie = `${SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

export const operatorSessionCookie = (token: string, maxAgeSeconds: number): string =>
  `${OPERATOR_SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${String(maxAgeSeconds)}`;

export const clearedOperatorCookie = `${OPERATOR_SESSION_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

/** argon2id with the library defaults, which are OWASP's recommended minimum (19 MiB, 2 passes, 1 lane). */
export const hashPassword = (password: string): Promise<string> => hash(password);

/** Built when the module loads, so the first unknown-email sign-in costs no more than any other. */
const throwawayHash = hash(newToken());

/**
 * Checks a password against a stored hash. Without a stored hash (unknown email) it still runs a full
 * verification against a throwaway hash, so a wrong email takes as long as a wrong password.
 */
export async function verifyPassword(storedHash: string | undefined, password: string): Promise<boolean> {
  if (storedHash === undefined) {
    await verify(await throwawayHash, password);
    return false;
  }
  return verify(storedHash, password);
}
