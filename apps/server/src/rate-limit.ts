/** Beyond this many tracked keys, expired windows are pruned before a new key is added. */
const PRUNE_THRESHOLD = 10_000;

/**
 * Fixed-window attempt counter per key (an IP address, an email, an owner id).
 * ponytail: in-process memory, so limits reset on restart and are per server instance; move the counters to
 * PostgreSQL if the API ever runs as more than one instance.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whole seconds until `key` may try again (0 if it may now), without counting an attempt. */
  check(key: string): number {
    const now = this.now();
    const window = this.windows.get(key);
    return window !== undefined && window.resetAt > now && window.count >= this.limit ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : 0;
  }

  /** Counts one attempt for `key`. Returns 0 when allowed, else the whole seconds until the window resets. */
  hit(key: string): number {
    const now = this.now();
    let window = this.windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      if (this.windows.size >= PRUNE_THRESHOLD) {
        this.prune(now);
      }
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count > this.limit ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : 0;
  }

  /** Takes back one attempt counted for `key` in its current window (for an attempt that turned out not to count). */
  refund(key: string): void {
    const window = this.windows.get(key);
    if (window !== undefined && window.resetAt > this.now() && window.count > 0) {
      window.count -= 1;
    }
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }
}

/**
 * The rate-limit key for a client address: an IPv4 address as is (IPv4-mapped IPv6 unwrapped), an IPv6 address by
 * its /64 network, which one subscriber usually holds whole and could otherwise rotate through.
 */
export function clientKey(ip: string): string {
  const address = ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice("::ffff:".length) : ip;
  if (!address.includes(":")) {
    return address;
  }
  const [head = "", tail] = address.split("%", 1)[0]?.split("::") ?? [];
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}
