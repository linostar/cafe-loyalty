import { describe, expect, it } from "vitest";
import { scramSha256Verifier } from "./scram.js";

describe("scramSha256Verifier", () => {
  it("matches the RFC 7677 test vector's keys for a known salt", () => {
    // RFC 7677 section 3: password "pencil", salt "W22ZaJ0SNY7soEsUEjb6gQ==", 4096 iterations.
    const verifier = scramSha256Verifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"));
    expect(verifier).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
  });

  it("never contains the password and uses a fresh salt each time", () => {
    const a = scramSha256Verifier("a-long-database-password");
    const b = scramSha256Verifier("a-long-database-password");
    expect(a).not.toContain("a-long-database-password");
    expect(a).not.toBe(b);
  });

  it("rejects non-ASCII passwords", () => {
    expect(() => scramSha256Verifier("كلمة-سر-طويلة-جدا")).toThrow(/printable ASCII/);
  });
});
