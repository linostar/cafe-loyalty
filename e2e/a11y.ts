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
  // The header's title never runs under its controls. Measured on the title's text, which a no-wrap heading can spill
  // out of its own box; text hidden for screen readers (1px boxes) is left out.
  const covered = await page.evaluate(() => {
    const header = document.querySelector("header");
    const title = header?.querySelector("h1");
    if (header === null || title === null || title === undefined) {
      return [];
    }
    // Each text node's own boxes, except inside an element hidden for screen readers (a 1px clipped box).
    const text: DOMRect[] = [];
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement?.getBoundingClientRect();
      if (parent === undefined || parent.width <= 1 || parent.height <= 1) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      text.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
    }
    return [...header.querySelectorAll("button, a, input, select")]
      .map((control) => ({ control, box: control.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0)
      .filter(({ box }) => text.some((rect) => rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top))
      .map(({ control }) => control.outerHTML.slice(0, 80));
  });
  expect(covered).toEqual([]);
}
