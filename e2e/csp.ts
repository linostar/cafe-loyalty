import type { Page } from "@playwright/test";

/**
 * Collects what the page's Content-Security-Policy (deploy/spa-csp.txt, sent by the preview servers as Caddy sends it)
 * refuses, from Chromium's console, so a test can expect none: a refusal that breaks nothing visible (a font, an image)
 * would otherwise pass unnoticed.
 */
export function cspViolations(page: Page): string[] {
  const refused: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy")) {
      refused.push(message.text());
    }
  });
  return refused;
}
