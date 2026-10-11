import { expect, type Page } from "@playwright/test";

const CONTROL_ROLES = ["button", "link", "textbox", "checkbox", "radio", "combobox", "spinbutton", "searchbox", "slider", "switch"];

/**
 * Fails when a control in the page's accessibility tree has no accessible name (AC 41: labels on every control). Reads
 * Playwright's ARIA snapshot, where a named control is `- button "Save"` and an unnamed one `- button` alone.
 */
export async function expectEveryControlNamed(page: Page): Promise<void> {
  const snapshot = await page.locator("body").ariaSnapshot();
  const unnamed = snapshot.split("\n").filter((line) => {
    const role = /^\s*- (\w+)/.exec(line)?.[1];
    return role !== undefined && CONTROL_ROLES.includes(role) && !line.trimStart().startsWith(`- ${role} "`);
  });
  expect(unnamed, "controls without an accessible name").toEqual([]);
}

/** Checks the page is laid out in `lang`'s direction and fits the phone's screen without scrolling sideways. */
export async function expectLanguageAndFit(page: Page, lang: "ar" | "en"): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("lang", lang);
  await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
  // Against the screen's width, not innerWidth: a mobile browser widens its layout viewport to fit content that overflows.
  const screenWidth = page.viewportSize()?.width ?? 0;
  const overflow = await page.evaluate((width) => document.documentElement.scrollWidth - width, screenWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}
