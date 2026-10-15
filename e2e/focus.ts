import { expect, type Page } from "@playwright/test";

/**
 * Walks the keyboard through the page both ways and checks that each control it focuses is drawn on top where it sits:
 * nothing sticky or layered covers it (AC 14, WCAG 2.4.11). Back up from the page's end, as Shift+Tab does, the browser
 * scrolls each control in at the viewport's top edge, under anything stuck there; down from the top, as Tab does, at
 * its bottom edge, under a bar kept at the bottom of the screen (the counter's action bar on a phone).
 */
export async function expectFocusNeverHidden(page: Page): Promise<void> {
  await walk(page, "Shift+Tab", "end");
  await walk(page, "Tab", "start");
}

async function walk(page: Page, key: "Tab" | "Shift+Tab", from: "start" | "end"): Promise<void> {
  await page.evaluate((top) => {
    (document.activeElement as HTMLElement | null)?.blur();
    if (top) {
      // Focusing the body moves the browser's starting point for Tab to the page's start.
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute("tabindex");
    }
    window.scrollTo(0, top ? 0 : document.documentElement.scrollHeight);
  }, from === "start");
  for (let step = 0; step < 100; step++) {
    await page.keyboard.press(key);
    const state = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) {
        return { done: true, covered: null };
      }
      const box = active.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { done: false, covered: hit !== null && active.contains(hit) ? null : `${active.outerHTML.slice(0, 80)} under ${hit?.outerHTML.slice(0, 80) ?? "nothing"}` };
    });
    if (state.done) {
      return;
    }
    expect(state.covered, `${key} from the page's ${from}`).toBeNull();
  }
  throw new Error(`${key} never left the page in 100 steps.`);
}
