import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const ITERATIONS = 4096;

/**
 * A PostgreSQL SCRAM-SHA-256 password verifier (the form stored in pg_authid). Passing this to
 * `ALTER ROLE ... PASSWORD` sets the password without the plaintext ever reaching the server or its logs.
 * Passwords must be printable ASCII, for which SASLprep is the identity.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[\x20-\x7e]+$/.test(password)) {
    throw new Error("Database passwords must be printable ASCII.");
  }
  const saltedPassword = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  return `SCRAM-SHA-256$${String(ITERATIONS)}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
