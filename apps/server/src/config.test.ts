import { EnvError } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
import { loadServerConfig } from "./config.js";

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
};

describe("loadServerConfig", () => {
  it("parses a valid environment and applies the defaults", () => {
    expect(loadServerConfig(valid)).toEqual({
      ...valid,
      PORT: 3000,
      SHUTDOWN_TIMEOUT_MS: 10_000,
      DATABASE_MAX_CONNECTIONS: 10,
      TRUST_PROXY_HOPS: 0,
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
