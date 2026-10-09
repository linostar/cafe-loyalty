/**
 * Freezes the sync requests a counter build sends, with the results the API must keep giving them (AC 27):
 * `pnpm --filter @cafe-loyalty/server freeze-sync-fixture <name>` writes sync-fixtures/<name>.json. Run it for each
 * counter release, with BUILD_ID and BUILT_AT set as the release build sets them, and never edit a fixture once its
 * release has shipped. The device key signs every event and is then thrown away; fixtures hold only test data.
 */
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { syncEventSigningPayload } from "@cafe-loyalty/shared";
import { z } from "zod";
import type { SyncFixture } from "./sync-fixtures.js";

const name = process.argv[2];
if (name === undefined || !/^[a-z0-9-]{1,80}$/.test(name)) {
  process.stderr.write("Usage: freeze-sync-fixture <name> (lower-case letters, digits and dashes)\n");
  process.exit(1);
}

const builtAt = process.env.BUILT_AT === undefined || process.env.BUILT_AT === "" ? new Date().toISOString() : process.env.BUILT_AT;
if (!z.iso.datetime({ offset: false }).safeParse(builtAt).success) {
  process.stderr.write("BUILT_AT must be an ISO 8601 UTC time, such as 2026-10-09T08:00:00Z.\n");
  process.exit(1);
}
const recordedAt = new Date().toISOString();
const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
const device = { deviceId: randomUUID(), keyId: randomUUID(), publicKey: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x ?? "", y: jwk.y ?? "" } };
const staffId = randomUUID();
let sequence = 0;

/** An event built and signed exactly as the counter's recordEvent does it (apps/counter/src/sync.ts). */
async function event(type: string, schemaVersion: number, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  sequence += 1;
  const fields = { eventId: randomUUID(), deviceId: device.deviceId, keyId: device.keyId, staffId, sequence, schemaVersion, type, occurredAt: recordedAt, payload };
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, Buffer.from(syncEventSigningPayload(fields)));
  return { ...fields, signature: Buffer.from(signature).toString("base64url") };
}

const item = { orderTypeId: randomUUID(), quantity: 2, unitPriceCents: 350, unitCostCents: 120, catalogVersion: 1 };
const byQr = await event("visit.recorded", 1, { card: { kind: "qr", token: `v1.${randomBytes(8).toString("hex")}` }, items: [item], totalCents: 700 });
// A fake test number (Lebanese mobile format).
const byPhone = await event("visit.recorded", 1, { card: { kind: "phone", phone: "+96170000000" }, items: [item], totalCents: 700 });
const lockout = await event("staff.pin_lockout", 1, { failedAttempts: 5, lockedUntil: new Date(Date.parse(recordedAt) + 30_000).toISOString() });
// A type no release will ever define, standing in for one a newer counter build sends: it must stay unsupported.
const fromTheFuture = await event("test.never-supported", 1, { note: "from a newer build" });
const malformed = await event("visit.recorded", 1, { card: { kind: "qr", token: "v1.x" }, items: [], totalCents: 0 });

const fixture: SyncFixture = {
  build: process.env.BUILD_ID ?? "dev",
  builtAt,
  recordedAt,
  device,
  staffId,
  requests: [
    {
      events: [byQr, byPhone, lockout, fromTheFuture, malformed],
      results: [
        { status: "applied", code: "OK" },
        { status: "applied", code: "OK" },
        { status: "applied", code: "OK" },
        { status: "retry_later", code: "UNSUPPORTED_EVENT" },
        { status: "rejected", code: "INVALID_EVENT" },
      ],
    },
    // The answer to the first request was lost, so the counter sends its events again.
    { events: [byQr, byPhone], results: [{ status: "duplicate", code: "DUPLICATE" }, { status: "duplicate", code: "DUPLICATE" }] },
  ],
};

const directory = new URL("../../sync-fixtures/", import.meta.url);
await mkdir(directory, { recursive: true });
const path = new URL(`${name}.json`, directory);
await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`Wrote ${path.pathname}\n`);
