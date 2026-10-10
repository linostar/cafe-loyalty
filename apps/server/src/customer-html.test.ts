import { createHash } from "node:crypto";
import { PRODUCT_NAME } from "@cafe-loyalty/shared";
import { describe, expect, it } from "vitest";
import { CUSTOMER_CSP, FONT_FILES, SafeHtml, count, html, page, pickLang, t } from "./customer-html.js";

describe("html", () => {
  it("escapes interpolated text and attribute values", () => {
    const hostile = `<script>alert("x")</script>' onload='x' & more`;
    const out = html`<p title="${hostile}">${hostile}</p>`.value;
    expect(out).not.toContain("<script>");
    expect(out).toBe(
      "<p title=\"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39; onload=&#39;x&#39; &amp; more\">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39; onload=&#39;x&#39; &amp; more</p>",
    );
  });

  it("keeps SafeHtml as is, joins arrays and drops empty values", () => {
    const inner = html`<b>${"a<b"}</b>`;
    expect(html`<i>${inner}</i>${[html`<u>1</u>`, "<2>"]}${null}${undefined}${false}${0}`.value).toBe("<i><b>a&lt;b</b></i><u>1</u>&lt;2&gt;0");
    expect(new SafeHtml("<x>").toString()).toBe("<x>");
  });
});

describe("t", () => {
  it("fills placeholders inside Unicode isolates, escaped when rendered", () => {
    expect(t("en", "joinTitle", { cafe: "مقهى <ب>" })).toBe("Get your loyalty card at ⁨مقهى <ب>⁩");
    expect(html`${t("en", "joinTitle", { cafe: "<x>" })}`.value).toContain("&lt;x&gt;");
  });
});

describe("count", () => {
  it("uses each language's plural forms", () => {
    expect([0, 1, 2, 9].map((n) => count("en", "stamps", n))).toEqual(["0 stamps", "1 stamp", "2 stamps", "9 stamps"]);
    expect([1, 2, 3, 11, 100].map((n) => count("ar", "stamps", n))).toEqual(["ختم واحد", "ختمان", "3 أختام", "11 ختمًا", "100 ختم"]);
    expect([1, 15].map((n) => count("en", "minutes", n))).toEqual(["1 minute", "15 minutes"]);
    expect([1, 2, 5].map((n) => count("ar", "minutes", n))).toEqual(["دقيقة واحدة", "دقيقتين", "5 دقائق"]);
  });
});

describe("page", () => {
  it("allows exactly its own stylesheet through the content security policy", () => {
    const document = page("en", "Title", html`<p>x</p>`, "/x?lang=ar");
    const style = /<style>([\s\S]*)<\/style>/.exec(document)?.[1] ?? "";
    const hash = createHash("sha256").update(style).digest("base64");
    expect(CUSTOMER_CSP).toContain(`style-src 'sha256-${hash}'`);
    expect(CUSTOMER_CSP).toMatch(/^default-src 'none';/);
    expect(document).not.toContain("<script");
  });

  it("allows only its own stylesheet, images, fonts and forms: no script, nothing from another origin", () => {
    expect(CUSTOMER_CSP.replace(/'sha256-[^']+'/, "'sha256-x'")).toBe(
      "default-src 'none'; style-src 'sha256-x'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  it("styles the page with the design system's self-hosted fonts, and names the product in the footer", () => {
    const document = page("en", "Title", html`<p>x</p>`, null);
    const style = /<style>([\s\S]*)<\/style>/.exec(document)?.[1] ?? "";
    expect(style).toContain("--color-espresso");
    expect(style).toContain(".loyalty-card");
    expect(style).not.toMatch(/url\((?!\/assets\/fonts\/)/);
    for (const file of FONT_FILES.keys()) {
      expect(style).toContain(`url(/assets/fonts/${file})`);
    }
    expect(document).toContain('<link rel="icon" type="image/svg+xml" href="/assets/logo.svg">');
    expect(document).toContain(`Loyalty card by \u2068${PRODUCT_NAME}\u2069</footer>`);
  });

  it("sets language and direction, and omits the language switch when asked", () => {
    expect(page("ar", "x", html``, "/x?lang=en")).toContain('<html lang="ar" dir="rtl">');
    expect(page("en", "x", html``, "/x?lang=ar")).toContain('<a href="/x?lang=ar" lang="ar">العربية</a>');
    expect(page("en", "x", html``, null)).not.toContain('class="lang"');
  });
});

describe("pickLang", () => {
  it("prefers the request, then the browser's first language, then Arabic", () => {
    expect(pickLang("en", "ar")).toBe("en");
    expect(pickLang(undefined, "en-GB,ar;q=0.8")).toBe("en");
    expect(pickLang(undefined, "fr-FR,en;q=0.8")).toBe("ar");
    expect(pickLang("xx", undefined)).toBe("ar");
  });
});
