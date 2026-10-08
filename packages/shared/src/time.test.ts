import { describe, expect, it } from "vitest";
import { BUSINESS_TIME_ZONE, localHourBucket } from "./time.js";

const at = (iso: string): Date => new Date(iso);

describe("localHourBucket", () => {
  it("defaults to Asia/Beirut", () => {
    expect(BUSINESS_TIME_ZONE).toBe("Asia/Beirut");
    // 2026-07-01 is a Wednesday; Beirut is UTC+3 in summer.
    expect(localHourBucket(at("2026-07-01T06:15:00Z"))).toEqual({ date: "2026-07-01", weekday: 3, hour: 9 });
  });

  it("uses UTC+2 in winter", () => {
    expect(localHourBucket(at("2026-01-15T06:15:00Z"))).toEqual({ date: "2026-01-15", weekday: 4, hour: 8 });
  });

  it("crosses midnight into the next local day", () => {
    expect(localHourBucket(at("2026-07-01T21:30:00Z"))).toEqual({ date: "2026-07-02", weekday: 4, hour: 0 });
  });

  describe("spring forward (Sunday 29 March 2026, 00:00 becomes 01:00)", () => {
    it("puts the last winter minute in Saturday 23:00", () => {
      expect(localHourBucket(at("2026-03-28T21:59:00Z"))).toEqual({ date: "2026-03-28", weekday: 6, hour: 23 });
    });

    it("skips the missing 00:00 hour", () => {
      expect(localHourBucket(at("2026-03-28T22:00:00Z"))).toEqual({ date: "2026-03-29", weekday: 7, hour: 1 });
    });
  });

  describe("fall back (Sunday 25 October 2026, 00:00 becomes Saturday 23:00 again)", () => {
    it("puts both real hours of the repeated 23:00 into Saturday 23:00", () => {
      expect(localHourBucket(at("2026-10-24T20:30:00Z"))).toEqual({ date: "2026-10-24", weekday: 6, hour: 23 });
      expect(localHourBucket(at("2026-10-24T21:30:00Z"))).toEqual({ date: "2026-10-24", weekday: 6, hour: 23 });
    });

    it("starts Sunday at 00:00 winter time", () => {
      expect(localHourBucket(at("2026-10-24T22:00:00Z"))).toEqual({ date: "2026-10-25", weekday: 7, hour: 0 });
    });
  });

  it("rejects an invalid date", () => {
    expect(() => localHourBucket(new Date("not a date"))).toThrow(RangeError);
  });
});
