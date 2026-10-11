import { describe, expect, it } from "vitest";
import { API_MESSAGES_AR, apiMessage, localiseApiMessage } from "./api-messages.js";
import { fill, langFromPreferences, plural, toLatinDigits } from "./i18n.js";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();

describe("langFromPreferences", () => {
  it("takes the first Arabic or English preference, else Arabic", () => {
    expect(langFromPreferences(["en-US", "ar"])).toBe("en");
    expect(langFromPreferences(["fr-FR", "ar-LB", "en"])).toBe("ar");
    expect(langFromPreferences(["fr-FR", "en-GB"])).toBe("en");
    expect(langFromPreferences(["fr-FR"])).toBe("ar");
    expect(langFromPreferences([])).toBe("ar");
  });
});

describe("fill and plural", () => {
  it("fills placeholders as they are in English and isolated in Arabic", () => {
    expect(fill("en", "Signed in as {email}", { email: "owner@example.com" })).toBe("Signed in as owner@example.com");
    expect(fill("ar", "مسجّل باسم {email}", { email: "owner@example.com" })).toBe("مسجّل باسم ⁨owner@example.com⁩");
    expect(fill("en", "{missing} stays", {})).toBe("{missing} stays");
  });

  it("picks English's and Arabic's plural forms", () => {
    const cards = { en: { one: "{n} card", other: "{n} cards" }, ar: { one: "بطاقة واحدة", two: "بطاقتان", few: "{n} بطاقات", other: "{n} بطاقة" } };
    expect(plural("en", cards, 1)).toBe("1 card");
    expect(plural("en", cards, 0)).toBe("0 cards");
    expect(plural("ar", cards, 1)).toBe("بطاقة واحدة");
    expect(plural("ar", cards, 2)).toBe("بطاقتان");
    expect(plural("ar", cards, 5)).toBe("⁨5⁩ بطاقات");
    expect(plural("ar", cards, 11)).toBe("⁨11⁩ بطاقة");
  });

  it("reads Arabic-Indic and Persian digits as ASCII", () => {
    expect(toLatinDigits("١٢٣٤٥٦")).toBe("123456");
    expect(toLatinDigits("۲.۵۰ $")).toBe("2.50 $");
  });
});

describe("the API's messages in Arabic", () => {
  it("gives every message Arabic with the same placeholders", () => {
    for (const [english, arabic] of Object.entries(API_MESSAGES_AR)) {
      const forms: string[] = typeof arabic === "string" ? [arabic] : Object.values(arabic);
      for (const form of forms) {
        expect(form, english).not.toBe("");
        // A plural form may spell the count out ("دقيقتين") instead of using {n}.
        const expected = placeholders(english).filter((name) => typeof arabic === "string" || name !== "n");
        expect(
          placeholders(form).filter((name) => typeof arabic === "string" || name !== "n"),
          english,
        ).toEqual(expected);
      }
    }
  });

  it("translates a message as sent, and one with its values filled in", () => {
    expect(localiseApiMessage("ar", "Your session has ended. Sign in again.")).toBe("انتهت جلستك. سجّل الدخول مجدداً.");
    expect(localiseApiMessage("ar", apiMessage("The request failed (HTTP {status}). Try again.", { status: 502 }))).toBe("فشل الطلب (HTTP ⁨502⁩). حاول مجدداً.");
    expect(localiseApiMessage("ar", apiMessage("Too many attempts. Wait {n} minutes and try again.", { n: 2 }))).toBe("محاولات كثيرة. انتظر دقيقتين وحاول مجدداً.");
    expect(localiseApiMessage("ar", apiMessage("Too many attempts. Wait {n} minutes and try again.", { n: 15 }))).toBe("محاولات كثيرة. انتظر ⁨15⁩ دقيقة وحاول مجدداً.");
  });

  it("leaves English, and messages it does not know, as they are", () => {
    expect(localiseApiMessage("en", "Your session has ended. Sign in again.")).toBe("Your session has ended. Sign in again.");
    expect(localiseApiMessage("ar", "A message from a newer server.")).toBe("A message from a newer server.");
  });

  it("does not try its patterns on a very long text, which could take long to fail", () => {
    const long = `${" would sell for , below its floor of  (cost  plus ".repeat(200)}x`;
    const started = performance.now();
    expect(localiseApiMessage("ar", long)).toBe(long);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
