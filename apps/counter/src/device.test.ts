import { COUNTER_BUILT_AT_HEADER, devicePairProofPayload, deviceTokenSigningPayload, type DevicePublicKeyJwk } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { DeviceUnpairedError, RequestError, deviceRequest, pairDevice, renewToken } from "./device.js";
import { addQueued, countQueued, getMeta, setMeta, storeStaff } from "./storage.js";
import { CAFE, envelope, fakeApi, staffEntry, storePairedDevice, verifies } from "./test-helpers.js";
import { z } from "zod";

const PAIRED = {
  deviceId: "7e57d3c1-0000-4000-8000-000000000001",
  keyId: "7e57d3c1-0000-4000-8000-000000000002",
  deviceName: "Front counter",
  cafe: CAFE,
  accessToken: "t".repeat(43),
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
};

const tokenReply = (accessToken = "r".repeat(43)) => ({ status: 200, body: { accessToken, accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() } });

describe("pairDevice", () => {
  it("registers a new non-extractable key and stores the device and its token (AC 17)", async () => {
    const calls = fakeApi(() => ({ status: 201, body: PAIRED }));
    const device = await pairDevice("ABCD1234EFGH");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/device/pair", headers: { [COUNTER_BUILT_AT_HEADER]: "2026-10-01T00:00:00.000Z" } });
    expect(calls[0]?.body).toEqual({ code: "ABCD1234EFGH", publicKey: { kty: "EC", crv: "P-256", x: expect.any(String) as unknown, y: expect.any(String) as unknown } });
    expect(device.privateKey.extractable).toBe(false);
    expect(await getMeta("device")).toMatchObject({ deviceId: PAIRED.deviceId, keyId: PAIRED.keyId, paired: true, cafe: CAFE });
    expect(await getMeta("token")).toEqual({ accessToken: PAIRED.accessToken, expiresAt: PAIRED.accessTokenExpiresAt, keyId: PAIRED.keyId });
  });

  it("proves the old key when pairing again, keeping the queue (AC 18)", async () => {
    const { device: old, publicKey } = await storePairedDevice({ paired: false, unpairedReason: "pairing_required" });
    await addQueued({ sequence: 1, eventId: "e1", type: "visit.recorded", occurredAt: "2026-10-01T00:00:00.000Z", event: {} });
    const calls = fakeApi(() => ({ status: 201, body: { ...PAIRED, deviceId: old.deviceId } }));
    await pairDevice("ABCD1234EFGH");
    const body = calls[0]?.body as { publicKey: DevicePublicKeyJwk; previous: { deviceId: string; keyId: string; signature: string } };
    expect(body.previous).toMatchObject({ deviceId: old.deviceId, keyId: old.keyId });
    expect(await verifies(publicKey, body.previous.signature, devicePairProofPayload("ABCD1234EFGH", old, body.publicKey))).toBe(true);
    expect(await verifies(publicKey, body.previous.signature, devicePairProofPayload("ABCD1234EFGJ", old, body.publicKey))).toBe(false);
    expect(await countQueued()).toBe(1);
    expect(await getMeta("device")).toMatchObject({ paired: true, unpairedReason: null, keyId: PAIRED.keyId });
  });

  it("forgets the baristas of another café", async () => {
    await storePairedDevice({ cafe: { id: "0f0f0f0f-0000-4000-8000-000000000000", name: "Elsewhere" } });
    await setMeta("staff", [await staffEntry("s1", "Rami", "482913")]);
    await setMeta("barista", { staffId: "s1" });
    fakeApi(() => ({ status: 201, body: PAIRED }));
    await pairDevice("ABCD1234EFGH");
    expect(await getMeta("staff")).toBeUndefined();
    expect(await getMeta("barista")).toBeUndefined();
  });

  it("starts over only when told to, when the phone is still paired with another café", async () => {
    await storePairedDevice({ cafe: { id: "0f0f0f0f-0000-4000-8000-000000000000", name: "Elsewhere" } });
    await addQueued({ sequence: 1, eventId: "e1", type: "visit.recorded", occurredAt: "2026-10-01T00:00:00.000Z", event: {} });
    const calls = fakeApi((call) =>
      (call.body as { previous?: unknown }).previous === undefined ? { status: 201, body: PAIRED } : { status: 409, body: envelope("PAIRED_ELSEWHERE") },
    );
    await expect(pairDevice("ABCD1234EFGH")).rejects.toMatchObject({ name: "PairedElsewhereError", cafeName: "Elsewhere" });
    expect(await countQueued()).toBe(1);
    await pairDevice("ABCD1234EFGH", { startOver: true });
    expect(calls[1]?.body).not.toHaveProperty("previous");
    expect(await countQueued()).toBe(0);
    expect(await getMeta("device")).toMatchObject({ deviceId: PAIRED.deviceId, cafe: CAFE });
  });

  it("asks for a new code when the answer is lost or unreadable, and shows the server's refusal", async () => {
    fakeApi(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(pairDevice("ABCD1234EFGH")).rejects.toThrow(/ask the owner for a new one/);
    fakeApi(() => ({ status: 502, body: "<html>Bad gateway</html>" }));
    await expect(pairDevice("ABCD1234EFGH")).rejects.toThrow(/could not be confirmed.*ask the owner for a new one/);
    fakeApi(() => ({ status: 400, body: envelope("PAIRING_CODE_INVALID", "This pairing code is wrong, used or expired.") }));
    await expect(pairDevice("ABCD1234EFGH")).rejects.toThrow("This pairing code is wrong, used or expired.");
    expect(await getMeta("device")).toBeUndefined();
  });
});

describe("tokens", () => {
  it("never land on a newer pairing: a renewal that finishes after pairing again is dropped", async () => {
    await storePairedDevice();
    await setMeta("token", { accessToken: "o".repeat(43), expiresAt: new Date(Date.now() - 1000).toISOString(), keyId: "4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a" });
    let releaseRenewal: () => void = () => undefined;
    const renewalHeld = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    fakeApi(async (call) => {
      if (call.path === "/api/device/token") {
        await renewalHeld;
        return tokenReply("s".repeat(43));
      }
      return { status: 201, body: PAIRED };
    });
    const stale = renewToken();
    await pairDevice("ABCD1234EFGH");
    releaseRenewal();
    await expect(stale).rejects.toBeInstanceOf(RequestError);
    expect(await getMeta("token")).toMatchObject({ accessToken: PAIRED.accessToken, keyId: PAIRED.keyId });
  });

  it("are renewed when the stored one belongs to an earlier pairing", async () => {
    await storePairedDevice();
    await setMeta("token", { accessToken: "o".repeat(43), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), keyId: "0d0d0d0d-0000-4000-8000-000000000000" });
    const calls = fakeApi((call) => (call.path === "/api/device/token" ? tokenReply() : { status: 200, body: {} }));
    await deviceRequest("GET", "/api/device/me", z.unknown());
    expect(calls.map((call) => call.path)).toEqual(["/api/device/token", "/api/device/me"]);
  });

  it("renew one at a time, each with a fresh, later issuedAt signed by the device key (AC 18)", async () => {
    const { device, publicKey } = await storePairedDevice();
    const calls = fakeApi(() => tokenReply());
    const [first, second] = await Promise.all([renewToken("a".repeat(43)), renewToken("a".repeat(43))]);
    expect(first).toBe(second);
    // The next renewal must not reuse the stored token, so let it expire.
    await setMeta("token", { accessToken: first.accessToken, expiresAt: new Date(Date.now() - 1000).toISOString(), keyId: first.keyId });
    expect(calls).toHaveLength(1);
    await renewToken(first.accessToken);
    const bodies = calls.map((call) => call.body as { deviceId: string; keyId: string; issuedAt: string; signature: string });
    expect(bodies[1]?.issuedAt.localeCompare(bodies[0]?.issuedAt ?? "")).toBe(1);
    for (const body of bodies) {
      expect(body).toMatchObject({ deviceId: device.deviceId, keyId: device.keyId });
      expect(await verifies(publicKey, body.signature, deviceTokenSigningPayload(body))).toBe(true);
    }
  });

  it("are renewed before a request when about to expire, and once more on TOKEN_EXPIRED", async () => {
    await storePairedDevice();
    await setMeta("token", { accessToken: "o".repeat(43), expiresAt: new Date(Date.now() + 10_000).toISOString(), keyId: "4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a" });
    let expireOnce = true;
    const calls = fakeApi((call) => {
      if (call.path === "/api/device/token") {
        return tokenReply(expireOnce ? "n".repeat(43) : "m".repeat(43));
      }
      if (expireOnce) {
        expireOnce = false;
        return { status: 401, body: envelope("TOKEN_EXPIRED") };
      }
      return { status: 200, body: { ok: true } };
    });
    expect(await deviceRequest("GET", "/api/device/me", z.object({ ok: z.boolean() }))).toEqual({ ok: true });
    expect(calls.map((call) => `${call.path} ${call.headers.authorization ?? ""}`)).toEqual([
      "/api/device/token ",
      `/api/device/me Bearer ${"n".repeat(43)}`,
      "/api/device/token ",
      `/api/device/me Bearer ${"m".repeat(43)}`,
    ]);
  });

  it("unpair a removed device, wiping its PIN hashes but keeping its key and queue (AC 21)", async () => {
    await storePairedDevice();
    await setMeta("staff", [await staffEntry("s1", "Rami", "482913")]);
    await setMeta("barista", { staffId: "s1" });
    await addQueued({ sequence: 1, eventId: "e1", type: "visit.recorded", occurredAt: "2026-10-01T00:00:00.000Z", event: {} });
    fakeApi(() => ({ status: 401, body: envelope("DEVICE_REVOKED") }));
    await expect(deviceRequest("GET", "/api/device/staff", z.unknown())).rejects.toBeInstanceOf(DeviceUnpairedError);
    expect(await getMeta("device")).toMatchObject({ paired: false, unpairedReason: "revoked" });
    expect(await getMeta("staff")).toBeUndefined();
    expect(await getMeta("barista")).toBeUndefined();
    expect(await getMeta("token")).toBeUndefined();
    expect(await countQueued()).toBe(1);
  });

  it("keep the baristas when the device only has to pair again", async () => {
    await storePairedDevice();
    await setMeta("staff", [await staffEntry("s1", "Rami", "482913")]);
    fakeApi(() => ({ status: 401, body: envelope("PAIRING_REQUIRED") }));
    await expect(renewToken("a".repeat(43))).rejects.toMatchObject({ reason: "pairing_required" });
    expect(await getMeta("staff")).toHaveLength(1);
  });
});

describe("storeStaff", () => {
  it("keeps only the baristas fetched for the current pairing and signs out a removed one", async () => {
    const { device } = await storePairedDevice();
    const rami = await staffEntry("s1", "Rami", "482913");
    expect(await storeStaff("0d0d0d0d-0000-4000-8000-000000000000", [rami])).toBe(false);
    expect(await getMeta("staff")).toBeUndefined();
    await setMeta("barista", { staffId: "gone" });
    expect(await storeStaff(device.keyId, [rami])).toBe(true);
    expect(await getMeta("staff")).toEqual([rami]);
    expect(await getMeta("barista")).toBeUndefined();
  });
});

describe("deviceRequest", () => {
  it("treats a proxy's HTML error page, an unknown code and a network failure as retryable (AC 28)", async () => {
    await storePairedDevice();
    for (const reply of [{ status: 502, body: "<html>Bad gateway</html>" }, { status: 400, body: envelope("SOMETHING_NEW") }]) {
      fakeApi(() => reply);
      const error: unknown = await deviceRequest("GET", "/api/device/me", z.unknown()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).failure.retryable).toBe(true);
    }
    fakeApi(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(deviceRequest("GET", "/api/device/me", z.unknown())).rejects.toMatchObject({ failure: { retryable: true, status: null } });
  });
});
