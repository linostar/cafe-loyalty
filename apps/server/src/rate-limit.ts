/** Beyond this many tracked keys, expired windows are pruned before a new key is added. */
const PRUNE_THRESHOLD = 10_000;
/** Hard cap on tracked keys (some are attacker-chosen, such as emails): the oldest windows are dropped beyond it. */
const MAX_KEYS = 50_000;

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
      // Maps iterate in insertion order, so this drops the longest-tracked keys first.
      for (const oldest of this.windows.keys()) {
        if (this.windows.size < MAX_KEYS) {
          break;
        }
        this.windows.delete(oldest);
      }
      window = { count: 0, resetAt: now + this.windowMs };
      // Re-inserted, so a reused key counts as newest for the eviction below.
      this.windows.delete(key);
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

  /** Forgets every key `matches` accepts, for example an account's lockout once its owner has proved control. */
  clearWhere(matches: (key: string) => boolean): void {
    for (const key of this.windows.keys()) {
      if (matches(key)) {
        this.windows.delete(key);
      }
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

/** The 8 groups of an IPv6 address (with an optional trailing dotted IPv4 part), or null if it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted !== null) {
    const octets = dotted.slice(2).map(Number);
    if (octets.some((octet) => octet > 255)) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${dotted[1] ?? ""}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const [head = "", tail] = halves;
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined ? missing !== 0 : missing < 1) {
    return null;
  }
  const groups = [...headGroups, ...Array<string>(Math.max(0, missing)).fill("0"), ...tailGroups];
  return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map((group) => Number.parseInt(group, 16)) : null;
}

/**
 * The rate-limit key for a client address: an IPv4 address as is, an IPv4-mapped IPv6 address (dotted or hex,
 * any case) as its IPv4 address, and any other IPv6 address by its /64 network, which one subscriber usually holds
 * whole and could otherwise rotate through.
 */
export function clientKey(ip: string): string {
  const address = (ip.toLowerCase().split("%", 1)[0] ?? "").trim();
  if (!address.includes(":")) {
    return address;
  }
  const groups = ipv6Groups(address);
  if (groups === null) {
    return address;
  }
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${String(g6 >> 8)}.${String(g6 & 0xff)}.${String(g7 >> 8)}.${String(g7 & 0xff)}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}
