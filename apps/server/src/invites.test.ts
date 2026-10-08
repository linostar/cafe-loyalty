import { describe, expect, it } from "vitest";
import { inviteLink, parseInviteArgs } from "./invites.js";

describe("parseInviteArgs", () => {
  it("takes a new café's name, trimmed", () => {
    expect(parseInviteArgs(["--cafe-name", "  Café Najjar "])).toEqual({ newCafeName: "Café Najjar" });
  });

  it("takes an existing café's id", () => {
    expect(parseInviteArgs(["--cafe-id", "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d"])).toEqual({ cafeId: "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d" });
  });

  it.each([
    [[]],
    [["--cafe-name", "A", "--cafe-id", "0b9a3c4d-1e2f-4a5b-8c7d-6e5f4a3b2c1d"]],
    [["--cafe-name", "   "]],
    [["--cafe-name", "x".repeat(121)]],
    [["--cafe-id", "not-a-uuid"]],
    [["--cafe", "A"]],
    [["--cafe-name"]],
  ])("refuses %j", (args) => {
    expect(parseInviteArgs(args)).toBeNull();
  });
});

describe("inviteLink", () => {
  it("puts the token in the fragment of the dashboard's signup page", () => {
    expect(inviteLink("https://dashboard.example.test", "A".repeat(43))).toBe(`https://dashboard.example.test/signup#invite=${"A".repeat(43)}`);
  });
});
