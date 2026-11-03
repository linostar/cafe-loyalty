import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

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
  const { overflow, past } = await page.evaluate((width) => ({
    overflow: document.documentElement.scrollWidth - width,
    // The deepest elements sticking out past either edge, to name in a failure.
    past: [...document.querySelectorAll("body *")]
      .filter((element) => {
        const out = (box: DOMRect) => box.width > 1 && (box.right > width + 0.5 || box.left < -0.5);
        return out(element.getBoundingClientRect()) && ![...element.children].some((child) => out(child.getBoundingClientRect()));
      })
      .slice(0, 5)
      .map((element) => element.outerHTML.slice(0, 80)),
  }), screenWidth);
  expect(overflow, `scrolls sideways; past the edge: ${past.join(" | ")}`).toBeLessThanOrEqual(0);
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

/**
 * Runs `check` with `css` applied to the page, then takes it off. A constructed style sheet, not a `<style>` element:
 * the pages' policies refuse inline styles, and a constructed sheet is outside them.
 */
async function withCss(page: Page, css: string, check: () => Promise<void>): Promise<void> {
  await page.evaluate((text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    (globalThis as unknown as { gateSheet?: CSSStyleSheet }).gateSheet = sheet;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, css);
  try {
    await check();
  } finally {
    await page.evaluate(() => {
      const sheet = (globalThis as unknown as { gateSheet?: CSSStyleSheet }).gateSheet;
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
    });
  }
}

/**
 * WCAG 1.4.12 (text spacing): with line height 1.5, paragraph spacing 2em, letter spacing 0.12em and word spacing
 * 0.16em on all text, the page still fits (expectLanguageAndFit) and no element cuts its text off: none that hides its
 * overflow has more content than room. Text hidden for screen readers (`.visually-hidden`) is left out.
 */
export async function expectTextSpacing(page: Page, lang: "ar" | "en"): Promise<void> {
  await withCss(page, "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-block-end: 2em !important; }", async () => {
    await expectLanguageAndFit(page, lang);
    const clipped = await page.evaluate((): string[] =>
      [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => element.clientWidth > 1 && element.clientHeight > 1 && element.closest(".visually-hidden") === null && element.textContent.trim() !== "")
        .filter((element) => {
          const style = getComputedStyle(element);
          const hides = (value: string) => value === "hidden" || value === "clip";
          return (hides(style.overflowX) && element.scrollWidth > element.clientWidth + 1) || (hides(style.overflowY) && element.scrollHeight > element.clientHeight + 1);
        })
        .map((element) => element.outerHTML.slice(0, 80)),
    );
    expect(clipped, "text cut off with WCAG 1.4.12 spacing").toEqual([]);
  });
}

/**
 * WCAG 1.4.4 (resize text): with text at 200%, the page still fits and its header title is clear of its controls
 * (expectLanguageAndFit). Only on screens 640 CSS px wide or more: on a phone, 200% text is past 400% zoom, which the
 * 320 px reflow check stands for (WCAG 1.4.10).
 */
export async function expectTextZoom(page: Page, lang: "ar" | "en"): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 640) {
    return;
  }
  await withCss(page, "html { font-size: 200% !important; }", async () => {
    await expectLanguageAndFit(page, lang);
  });
}

/** The axe rule tags of WCAG 2.0, 2.1 and 2.2 at levels A and AA: the level the product meets. */
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Rules outside the WCAG tags that still guard what screen-reader users rely on: headings that never skip a level, so
 * the outline read from them has no gaps (WCAG 1.3.1's intent; axe files it under best practice).
 */
const EXTRA_RULES = ["heading-order"];

/**
 * Fails on any WCAG 2.2 A or AA violation axe finds in the page as drawn: contrast of the colours actually rendered,
 * ARIA validity, landmarks, headings, lists, duplicate ids, and targets of at least 24 px (2.5.8), and on EXTRA_RULES.
 * `skip` names rules a screen leaves out, each with its reason at the call.
 */
export async function expectNoAxeViolations(page: Page, skip: readonly string[] = []): Promise<void> {
  // Two passes: axe runs either rule tags or named rules, not both at once.
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA).disableRules([...skip]).analyze();
  const extra = EXTRA_RULES.filter((rule) => !skip.includes(rule));
  const more = extra.length === 0 ? [] : (await new AxeBuilder({ page }).withRules(extra).analyze()).violations;
  const found = [...violations, ...more].map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`);
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
      // In a sentence: its parent holds text of its own beside its links (two links side by side are still targets).
      const inSentence =
        control instanceof HTMLAnchorElement &&
        [...(control.parentElement?.childNodes ?? [])].some((node) => !(node instanceof HTMLAnchorElement) && (node.textContent ?? "").trim() !== "");
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
 * needs a border of its own to be seen as one, and every control the keyboard reaches must still show its focus: an
 * outline on the control or on the element that draws its ring (a tile's list item, through `:focus-within`).
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
    // blur() leaves the browser's starting point for Tab where the control was: focusing the body moves it to the page's start.
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    window.scrollTo(0, 0);
    (globalThis as unknown as { ringsSeen?: WeakSet<Element> }).ringsSeen = new WeakSet();
  });
  const unringed: string[] = [];
  // Tab through the page once: it ends when focus leaves the page (the body again) or comes back to a control already seen.
  for (let step = 0, started = false; step < 300; step++) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) {
        return "body";
      }
      const seen = (globalThis as unknown as { ringsSeen: WeakSet<Element> }).ringsSeen;
      if (seen.has(active)) {
        return "again";
      }
      seen.add(active);
      for (let node: Element | null = active; node !== null && node !== document.body; node = node.parentElement) {
        // A ring that shows: a style other than none, at a width above zero.
        const style = getComputedStyle(node);
        if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) {
          return "ringed";
        }
      }
      return active.outerHTML.slice(0, 80);
    });
    if (state === "again" || (state === "body" && started)) {
      break;
    }
    started ||= state !== "body";
    if (state !== "body" && state !== "ringed") {
      unringed.push(state);
    }
  }
  expect(unringed, "controls with no focus ring under forced colours").toEqual([]);
  await page.emulateMedia({ forcedColors: "none" });
}

/** The text an element shows on screen: its text without the parts hidden for screen readers (`.visually-hidden`). */
export async function shownText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll(".visually-hidden")) {
      hidden.remove();
    }
    return copy.textContent.replace(/\s+/g, " ").trim();
  });
}
