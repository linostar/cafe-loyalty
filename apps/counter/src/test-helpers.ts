import { vi } from "vitest";
import { toBase64Url } from "./device.js";
import { setMeta, type DeviceRecord, type StaffEntry } from "./storage.js";

export interface ApiCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeReply {
  status: number;
  /** JSON body, or a string sent as it is (a proxy's HTML page, for example). */
  body?: unknown;
}

/** Replaces fetch with `handler`; returns the calls made, in order. A thrown error is a network failure. */
export function fakeApi(handler: (call: ApiCall) => FakeReply | Promise<FakeReply>): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const call: ApiCall = {
        method: init.method ?? "GET",
        path: input,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const reply = await handler(call);
      const text = reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      return new Response(text, { status: reply.status });
    }),
  );
  return calls;
}

export const envelope = (code: string, message = `Server says ${code}.`) => ({ code, message, retryable: false });

export const CAFE = { id: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d", name: "Café Najjar" };

/** A paired device stored as pairing leaves it, with a fresh non-extractable key; returns its public key to verify with. */
export async function storePairedDevice(overrides: Partial<DeviceRecord> = {}): Promise<{ device: DeviceRecord; publicKey: CryptoKey }> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const device: DeviceRecord = {
    deviceId: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
    keyId: "4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a",
    privateKey: keys.privateKey,
    deviceName: "Front counter",
    cafe: CAFE,
    paired: true,
    unpairedReason: null,
    ...overrides,
  };
  await setMeta("device", device);
  await setMeta("token", { accessToken: "a".repeat(43), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  return { device, publicKey: keys.publicKey };
}

/** A barista whose PIN hash is made as the server makes it, with few iterations so tests stay fast. */
export async function staffEntry(id: string, name: string, pin: string, iterations = 1000): Promise<StaffEntry> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
  return { id, name, pinSalt: toBase64Url(salt), pinHash: toBase64Url(hash), pinIterations: iterations };
}

export async function verifies(publicKey: CryptoKey, signature: string, text: string): Promise<boolean> {
  const bytes = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, bytes, new TextEncoder().encode(text));
}
