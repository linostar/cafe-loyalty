import { expect, test } from "@playwright/test";
import { NOT_A_CARD_FILE } from "./camera.js";
import { expectInBothLanguages, signedIn } from "./fixtures.js";

/**
 * A QR code that is not a loyalty card in front of the camera (UX Phase 6, K15): its own camera picture, a menu link,
 * so its own file. Checked like the counter's screens, in English and then Arabic, on a tablet and a phone.
 */
test.use({
  serviceWorkers: "block",
  timezoneId: "Asia/Beirut",
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${NOT_A_CARD_FILE}`] },
});

for (const { width, height } of [
  { width: 1024, height: 768 },
  { width: 360, height: 740 },
] as const) {
  test.describe(`at ${String(width)} px`, () => {
    test.use({ viewport: { width, height }, isMobile: width < 640, hasTouch: true });

    test("a QR code that is not a loyalty card", async ({ page }) => {
      await signedIn(page);
      await page.getByRole("button", { name: "Scan card", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("That QR code is not a loyalty card.");
      await expectInBothLanguages(page, /رمز QR هذا ليس بطاقة ولاء/);
    });
  });
}
