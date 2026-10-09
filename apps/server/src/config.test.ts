import { EnvError } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { selfSigned } from "./testing/certificates.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

const valid = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3000",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgres://app:secret@127.0.0.1:5432/cafe_loyalty",
  DASHBOARD_URL: "https://dashboard.example.com",
  COUNTER_URL: "https://counter.example.com",
  PUBLIC_URL: "https://card.example.com",
  PHONE_LOOKUP_PEPPER: KEY_A,
  PHONE_ENCRYPTION_KEYS: `p2:${KEY_B},p1:${KEY_A}`,
  CARD_QR_KEYS: `q1:${KEY_A}`,
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "mailer",
  SMTP_PASSWORD: "smtp-secret",
  EMAIL_FROM: "Cafe Loyalty <no-reply@example.com>",
  BUILT_AT: "2026-10-01T09:30:00Z",
};

describe("loadServerConfig", () => {
  it("parses a valid environment and applies the defaults", () => {
    expect(loadServerConfig(valid)).toEqual({
      ...valid,
      PORT: 3000,
      SHUTDOWN_TIMEOUT_MS: 10_000,
      DATABASE_MAX_CONNECTIONS: 10,
      TRUST_PROXY_HOPS: 0,
      BUILT_AT: new Date("2026-10-01T09:30:00Z"),
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      PHONE_ENCRYPTION_KEYS: [
        { id: "p2", key: Buffer.alloc(32, 2) },
        { id: "p1", key: Buffer.alloc(32, 1) },
      ],
      CARD_QR_KEYS: [{ id: "q1", key: Buffer.alloc(32, 1) }],
    });
  });

  it("refuses short secrets and malformed or duplicate keyring entries, without echoing them", () => {
    for (const bad of [
      { PHONE_LOOKUP_PEPPER: Buffer.alloc(16).toString("base64") },
      { PHONE_ENCRYPTION_KEYS: `p1:${Buffer.alloc(16).toString("base64")}` },
      { CARD_QR_KEYS: `Q1:${KEY_A}` },
      { CARD_QR_KEYS: `q1:${KEY_A},q1:${KEY_B}` },
      { CARD_QR_KEYS: "" },
      { CARD_QR_KEYS: `q1:${KEY_A}!` },
    ]) {
      try {
        loadServerConfig({ ...valid, ...bad });
        expect.unreachable();
      } catch (error) {
        const message = (error as EnvError).message;
        expect(message).toContain(Object.keys(bad)[0] ?? "");
        expect(message).not.toContain(KEY_A);
      }
    }
  });

  it("requires an https PUBLIC_URL in production", () => {
    expect(() => loadServerConfig({ ...valid, NODE_ENV: "production", TRUST_PROXY_HOPS: "1", PUBLIC_URL: "http://card.example.com" })).toThrow(/PUBLIC_URL/);
  });

  it("rejects a missing HOST and an invalid PORT", () => {
    expect(() => loadServerConfig({ ...valid, HOST: undefined, PORT: "99999" })).toThrow(EnvError);
  });

  it("requires proxy hops and an https dashboard in production", () => {
    expect(() => loadServerConfig({ ...valid, NODE_ENV: "production" })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => loadServerConfig({ ...valid, NODE_ENV: "production", TRUST_PROXY_HOPS: "1", COUNTER_URL: "http://counter.example.com" })).toThrow(
      /COUNTER_URL/,
    );
    expect(() => loadServerConfig({ ...valid, NODE_ENV: "production", TRUST_PROXY_HOPS: "1", DASHBOARD_URL: "http://dash.example.com" })).toThrow(
      /DASHBOARD_URL/,
    );
    expect(loadServerConfig({ ...valid, NODE_ENV: "production", TRUST_PROXY_HOPS: "1" }).TRUST_PROXY_HOPS).toBe(1);
    expect(loadServerConfig({ ...valid, NODE_ENV: "production", TRUST_PROXY_HOPS: "1", DASHBOARD_URL: "HTTPS://Dash.Example.com" }).NODE_ENV).toBe(
      "production",
    );
  });

  it("requires the release's build time in production and defaults it to the start time elsewhere", () => {
    expect(() => loadServerConfig({ ...valid, NODE_ENV: "production", TRUST_PROXY_HOPS: "1", BUILT_AT: undefined })).toThrow(/BUILT_AT/);
    expect(() => loadServerConfig({ ...valid, BUILT_AT: "yesterday" })).toThrow(/BUILT_AT/);
    const before = Date.now();
    expect(loadServerConfig({ ...valid, BUILT_AT: undefined }).BUILT_AT.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("requires the dashboard address without a path", () => {
    expect(() => loadServerConfig({ ...valid, DASHBOARD_URL: "https://example.com/dashboard" })).toThrow(/DASHBOARD_URL/);
    expect(loadServerConfig({ ...valid, DASHBOARD_URL: "https://dashboard.example.com/" }).DASHBOARD_URL).toBe("https://dashboard.example.com/");
  });

  it("allows no SMTP login outside production, never half of one, and needs an address in EMAIL_FROM", () => {
    expect(loadServerConfig({ ...valid, SMTP_USER: undefined, SMTP_PASSWORD: undefined }).SMTP_USER).toBeUndefined();
    expect(() => loadServerConfig({ ...valid, SMTP_PASSWORD: undefined })).toThrow(/SMTP_PASSWORD/);
    expect(() => loadServerConfig({ ...valid, NODE_ENV: "production", TRUST_PROXY_HOPS: "1", SMTP_USER: undefined, SMTP_PASSWORD: undefined })).toThrow(
      /SMTP_USER/,
    );
    expect(() => loadServerConfig({ ...valid, EMAIL_FROM: "Cafe Loyalty" })).toThrow(/EMAIL_FROM/);
    expect(loadServerConfig({ ...valid, EMAIL_FROM: "no-reply@example.com" }).EMAIL_FROM).toBe("no-reply@example.com");
  });

  it("takes Apple Wallet settings all together or not at all, checking the certificates and that the key fits", () => {
    const signer = selfSigned("Pass Type ID: pass.example.test");
    const other = selfSigned("Another");
    const wwdr = selfSigned("WWDR");
    const b64 = (pem: string) => Buffer.from(pem).toString("base64");
    const apple = {
      APPLE_PASS_TYPE_ID: "pass.example.test",
      APPLE_TEAM_ID: "TEAMID1234",
      APPLE_PASS_CERTIFICATE: b64(signer.certificate),
      APPLE_PASS_KEY: b64(signer.privateKey),
      APPLE_WWDR_CERTIFICATE: b64(wwdr.certificate),
    };
    expect(loadServerConfig(valid).applePasses).toBeUndefined();
    expect(loadServerConfig({ ...valid, ...apple }).applePasses).toEqual({
      passTypeId: "pass.example.test",
      teamId: "TEAMID1234",
      certificates: { signerCert: signer.certificate, signerKey: signer.privateKey, wwdr: wwdr.certificate },
    });
    expect(() => loadServerConfig({ ...valid, ...apple, APPLE_WWDR_CERTIFICATE: undefined })).toThrow(/APPLE_WWDR_CERTIFICATE/);
    expect(() => loadServerConfig({ ...valid, ...apple, APPLE_PASS_KEY: b64(other.privateKey) })).toThrow(/APPLE_PASS_KEY: Use the private key/);
    try {
      loadServerConfig({ ...valid, ...apple, APPLE_PASS_KEY: b64("not a key"), APPLE_TEAM_ID: "team" });
      expect.unreachable();
    } catch (error) {
      const message = (error as EnvError).message;
      expect(message).toContain("APPLE_PASS_KEY");
      expect(message).toContain("APPLE_TEAM_ID");
      expect(message).not.toContain(b64("not a key"));
    }
  });

  it("names invalid variables without their values", () => {
    try {
      loadServerConfig({ ...valid, DATABASE_URL: "mysql://app:leaked-password@db/x", SMTP_SECURE: "yes" });
      expect.unreachable();
    } catch (error) {
      const message = (error as EnvError).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("SMTP_SECURE");
      expect(message).not.toContain("leaked-password");
    }
  });
});
