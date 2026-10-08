import { EnvError } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";

const valid = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3000",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgres://app:secret@127.0.0.1:5432/cafe_loyalty",
  DASHBOARD_URL: "https://dashboard.example.com",
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
    });
  });

  it("rejects a missing HOST and an invalid PORT", () => {
    expect(() => loadServerConfig({ ...valid, HOST: undefined, PORT: "99999" })).toThrow(EnvError);
  });

  it("requires proxy hops and an https dashboard in production", () => {
    expect(() => loadServerConfig({ ...valid, NODE_ENV: "production" })).toThrow(/TRUST_PROXY_HOPS/);
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
