import { describe, expect, it } from "vitest";
import { nextStep } from "./customer-pages.js";

describe("nextStep", () => {
  it("leads a link or card that no longer works to recovery, in the page's language", () => {
    expect(nextStep("en", "linkExpired", "POST", "/r/x")).toEqual({ href: "/recover?lang=en", label: "Ask for a new link" });
    expect(nextStep("ar", "cardGone", "GET", "/c/x")).toEqual({ href: "/recover?lang=ar", label: "استعد بطاقتك" });
  });

  it("offers the same page again after our own failure on a page load, never after a failed form", () => {
    expect(nextStep("en", "failed", "GET", "/c/x/settings")).toEqual({ href: "/c/x/settings?lang=en", label: "Try again" });
    // A form's path answers only its post: a link to it would be a page that does not exist.
    expect(nextStep("en", "failed", "POST", "/c/x/email")).toBeUndefined();
  });

  it("gives no way on where there is none", () => {
    for (const key of ["notFound", "joinGone", "joinPaused", "badRequest", "tooMany", "crossSite"] as const) {
      expect(nextStep("en", key, "GET", "/join/x")).toBeUndefined();
    }
  });
});
