import { expect, type Page } from "@playwright/test";

/**
 * Walks the keyboard back up the page from its end, as Shift+Tab does, and checks that each control it focuses is
 * drawn on top where it sits: nothing sticky or layered covers it (AC 14). Going up is the case that matters, since the
 * browser then scrolls each control in at the viewport's top edge, under anything stuck there.
 */
export async function expectFocusNeverHidden(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  for (let step = 0; step < 100; step++) {
    await page.keyboard.press("Shift+Tab");
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
    expect(state.covered).toBeNull();
  }
  throw new Error("Shift+Tab never left the page in 100 steps.");
}
