import { expect, type Page } from "@playwright/test";

/**
 * Walks the keyboard through the page both ways and checks that each control it focuses is drawn on top where it sits:
 * nothing sticky or layered covers it (AC 14, WCAG 2.4.11), and that it shows its focus in normal colours: an outline at
 * least `--focus-width` wide, on it or on the element that draws its ring (`:focus-within`), at 3:1 or more against what
 * is behind the ring (WCAG 2.4.7, 1.4.11; forced colours are expectUsableInForcedColors'). Back up from the page's end, as Shift+Tab does, the browser
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
        return { done: true, covered: null, ring: null };
      }
      const box = active.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const covered = hit !== null && active.contains(hit) ? null : `${active.outerHTML.slice(0, 80)} under ${hit?.outerHTML.slice(0, 80) ?? "nothing"}`;

      /** [r, g, b, alpha] of a computed colour such as rgb(1, 2, 3) or rgba(1, 2, 3, 0.5). */
      const rgba = (colour: string): number[] => {
        const [r = 0, g = 0, b = 0, a = 1] = (colour.match(/[\d.]+/g) ?? []).map(Number);
        return [r, g, b, a];
      };
      const linear = (channel: number) => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
      const luminance = ([r = 0, g = 0, b = 0]: number[]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      /** The colour behind `element`'s ring: its parents' backgrounds, laid over each other down to the page's white. */
      const behind = (element: Element): number[] => {
        const layers: number[][] = [];
        for (let node = element.parentElement; node !== null; node = node.parentElement) {
          const layer = rgba(getComputedStyle(node).backgroundColor);
          if ((layer[3] ?? 0) > 0) {
            layers.push(layer);
            if (layer[3] === 1) {
              break;
            }
          }
        }
        return layers.reduceRight((under, [r = 0, g = 0, b = 0, a = 1]) => [r * a + (under[0] ?? 255) * (1 - a), g * a + (under[1] ?? 255) * (1 - a), b * a + (under[2] ?? 255) * (1 - a)], [255, 255, 255]);
      };
      const minimum = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--focus-width"));
      let ring: string | null = `${active.outerHTML.slice(0, 80)}: no focus ring`;
      for (let node: Element | null = active; node !== null && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.outlineStyle === "none" || Number.parseFloat(style.outlineWidth) === 0) {
          continue;
        }
        const [lighter, darker] = [luminance(rgba(style.outlineColor)), luminance(behind(node))].sort((a, b) => b - a);
        const contrast = ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
        ring =
          Number.parseFloat(style.outlineWidth) < minimum
            ? `${active.outerHTML.slice(0, 80)}: a ${style.outlineWidth} ring, under --focus-width`
            : contrast < 3
              ? `${active.outerHTML.slice(0, 80)}: its ring at ${contrast.toFixed(2)}:1`
              : null;
        break;
      }
      return { done: false, covered, ring };
    });
    if (state.done) {
      return;
    }
    expect(state.covered, `${key} from the page's ${from}`).toBeNull();
    expect(state.ring, `focus ring, ${key} from the page's ${from}`).toBeNull();
  }
  throw new Error(`${key} never left the page in 100 steps.`);
}
