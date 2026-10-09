import { describe, expect, it } from "vitest";
import { RateLimiter, clientKey } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows `limit` hits per window, then reports the seconds left", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.hit("a")).toBe(0);
    expect(limiter.hit("a")).toBe(0);
    now = 15_000;
    expect(limiter.hit("a")).toBe(45);
    expect(limiter.hit("b")).toBe(0);
  });

  it("checks without counting", () => {
    const limiter = new RateLimiter(1, 1_000, () => 0);
    expect(limiter.check("a")).toBe(0);
    expect(limiter.check("a")).toBe(0);
    limiter.hit("a");
    expect(limiter.check("a")).toBe(1);
  });

  it("refunds an attempt within its window", () => {
    const limiter = new RateLimiter(1, 1_000, () => 0);
    limiter.hit("a");
    limiter.refund("a");
    expect(limiter.hit("a")).toBe(0);
    limiter.refund("unknown");
  });

  it("starts a new window once the old one ends", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    expect(limiter.hit("a")).toBe(0);
    expect(limiter.hit("a")).toBe(1);
    now = 1_000;
    expect(limiter.hit("a")).toBe(0);
  });

  it("never tracks more than 50,000 keys, dropping the oldest", () => {
    const limiter = new RateLimiter(1, 60_000, () => 0);
    for (let index = 0; index < 50_010; index += 1) {
      limiter.hit(`key-${String(index)}`);
    }
    const windows = (limiter as unknown as { windows: Map<string, unknown> }).windows;
    expect(windows.size).toBe(50_000);
    expect(windows.has("key-0")).toBe(false);
    expect(windows.has("key-50009")).toBe(true);
  });

  it("clears matching keys", () => {
    const limiter = new RateLimiter(1, 60_000, () => 0);
    limiter.hit("rana@example.com 203.0.113.1");
    limiter.hit("sami@example.com 203.0.113.1");
    limiter.clearWhere((key) => key.startsWith("rana@example.com "));
    expect(limiter.check("rana@example.com 203.0.113.1")).toBe(0);
    expect(limiter.check("sami@example.com 203.0.113.1")).toBe(60);
  });

  it("forgets expired keys once many are tracked", () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    for (let index = 0; index < 10_000; index += 1) {
      limiter.hit(`key-${String(index)}`);
    }
    now = 2_000;
    limiter.hit("fresh");
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBe(1);
  });
});

describe("clientKey", () => {
  it("keeps IPv4 addresses and unwraps IPv4-mapped ones", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("groups IPv6 addresses by their /64 network", () => {
    expect(clientKey("2001:db8:85a3:12:8a2e:370:7334:1")).toBe("2001:db8:85a3:12::/64");
    expect(clientKey("2001:db8:85a3:12::99")).toBe("2001:db8:85a3:12::/64");
    expect(clientKey("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("unwraps every IPv4-mapped form, so they never share ::1's bucket", () => {
    expect(clientKey("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(clientKey("0:0:0:0:0:ffff:cb00:7107")).toBe("203.0.113.7");
    expect(clientKey("2001:DB8::1")).toBe(clientKey("2001:db8::2"));
  });

  it("keeps an unparseable address as its own key", () => {
    expect(clientKey("1::2::3")).toBe("1::2::3");
    expect(clientKey("::ffff:999.1.1.1")).toBe("::ffff:999.1.1.1");
  });
});
