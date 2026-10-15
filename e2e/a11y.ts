import { AxeBuilder } from "@axe-core/playwright";
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

/** The axe rule tags of WCAG 2.0, 2.1 and 2.2 at levels A and AA: the level the product meets. */
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Fails on any WCAG 2.2 A or AA violation axe finds in the page as drawn: contrast of the colours actually rendered,
 * ARIA validity, landmarks, headings, lists, duplicate ids, and targets of at least 24 px (2.5.8). `skip` names rules a
 * screen leaves out, each with its reason at the call.
 */
export async function expectNoAxeViolations(page: Page, skip: readonly string[] = []): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).disableRules([...skip]).analyze();
  const found = violations.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`);
  expect(found, "WCAG 2.2 AA violations").toEqual([]);
}

/**
 * Fails when a control is smaller than 44 by 44 CSS px, the size a thumb hits reliably: for the screens used by touch
 * (the counter and the customer pages). A checkbox or radio is measured by its label, which takes the tap; a link inside
 * a sentence is exempt, as in WCAG 2.5.8, and so is text hidden for screen readers (a 1 px box).
 */
export async function expectTouchTargets(page: Page): Promise<void> {
  const small = await page.evaluate((minimum) => {
    const controls = document.querySelectorAll<HTMLElement>("a[href], button, input:not([type='hidden']), select, textarea, summary, [role='button']");
    return [...controls].flatMap((control) => {
      const choice = control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio");
      const box = (choice ? (control.closest("label") ?? control) : control).getBoundingClientRect();
      const inSentence = control instanceof HTMLAnchorElement && (control.parentElement?.textContent.trim().length ?? 0) > (control.textContent.trim().length);
      if (box.width <= 1 || box.height <= 1 || inSentence) {
        return [];
      }
      return box.width < minimum || box.height < minimum ? [`${String(Math.round(box.width))}x${String(Math.round(box.height))} ${control.outerHTML.slice(0, 80)}`] : [];
    });
  }, 44);
  expect(small, "touch targets under 44 px").toEqual([]);
}

/**
 * Under forced colours (Windows high contrast) the browser drops backgrounds and shadows, so every button and field
 * needs a border of its own to be seen as one, and the keyboard focus must still show (an outline, not a shadow).
 */
export async function expectUsableInForcedColors(page: Page): Promise<void> {
  await page.emulateMedia({ forcedColors: "active" });
  const borderless = await page.evaluate(() =>
    [...document.querySelectorAll("button, input:not([type='hidden'], [type='checkbox'], [type='radio']), select, textarea")]
      .filter((control) => control.getBoundingClientRect().width > 1)
      .filter((control) => {
        const style = getComputedStyle(control);
        return [style.borderBlockStartWidth, style.borderBlockEndWidth, style.borderInlineStartWidth, style.borderInlineEndWidth].every((width) => Number.parseFloat(width) === 0);
      })
      .map((control) => control.outerHTML.slice(0, 80)),
  );
  expect(borderless, "controls with no border under forced colours").toEqual([]);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  // From a blurred control at the page's end, the first Tab can leave for the browser's own controls.
  for (let step = 0; step < 3 && (await page.evaluate(() => document.activeElement === document.body)); step++) {
    await page.keyboard.press("Tab");
  }
  const focused = await page.evaluate(() => {
    const active = document.activeElement ?? document.body;
    return { control: active.outerHTML.slice(0, 80), outline: active === document.body ? "none" : getComputedStyle(active).outlineStyle };
  });
  expect(focused.outline, `focus ring under forced colours on ${focused.control}`).not.toBe("none");
  await page.emulateMedia({ forcedColors: "none" });
}
