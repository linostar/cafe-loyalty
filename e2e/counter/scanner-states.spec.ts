import { expect, test } from "@playwright/test";
import { expectAccessible, expectInBothLanguages, signedIn } from "./fixtures.js";

/**
 * The scanner's own states (UX Phase 6, K15), on a camera that shows no QR code (Chromium's test pattern), so the
 * scanner stays open: open with its torch, timed out, and the camera refused, missing or failing. Each is checked like
 * the counter's screens, in English and then Arabic, on a tablet and a phone. Fake data only.
 */
test.use({ serviceWorkers: "block", timezoneId: "Asia/Beirut", launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } });

for (const { width, height } of [
  { width: 1024, height: 768 },
  { width: 360, height: 740 },
] as const) {
  test.describe(`scanner states at ${String(width)} px`, () => {
    test.use({ viewport: { width, height }, isMobile: width < 640, hasTouch: true });

    test("open, with its torch on", async ({ page }) => {
      // A camera with a torch: Chromium's fake camera has none.
      await page.addInitScript(() => {
        MediaStreamTrack.prototype.getCapabilities = () => ({ torch: true }) as MediaTrackCapabilities;
        MediaStreamTrack.prototype.applyConstraints = () => Promise.resolve();
      });
      await signedIn(page);
      await page.getByRole("button", { name: "Scan card", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Scan the customer's card" })).toBeVisible();
      await expect(page.locator("video.camera")).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
      const torch = page.getByRole("button", { name: "Torch" });
      await expect(torch).toHaveAttribute("aria-pressed", "false");
      // Torch off, then on: each checked.
      await expectAccessible(page, "en");
      await torch.click();
      await expect(torch).toHaveAttribute("aria-pressed", "true");
      await expectInBothLanguages(page, "امسح بطاقة الزبون");
    });

    test("off after a minute without a card", async ({ page }) => {
      await signedIn(page);
      await page.getByRole("button", { name: "Scan card", exact: true }).click();
      await expect(page.locator("video.camera")).toBeVisible();
      await page.clock.fastForward(60_000);
      await expect(page.getByText(/^The camera turned off after a minute without a card/)).toBeVisible();
      await expectInBothLanguages(page, /أُطفئت الكاميرا بعد دقيقة/);
    });

    for (const [name, english, arabic] of [
      ["NotAllowedError", "The camera is not allowed.", /الكاميرا غير مسموح بها/],
      ["NotFoundError", "No camera was found on this phone.", /لم يُعثر على كاميرا في هذا الهاتف/],
      ["NotReadableError", "The camera could not start.", /تعذّر تشغيل الكاميرا/],
    ] as const) {
      test(`a camera that fails: ${name}`, async ({ page }) => {
        await page.addInitScript((error) => {
          MediaDevices.prototype.getUserMedia = () => Promise.reject(new DOMException("Fake failure for the test.", error));
        }, name);
        await signedIn(page);
        await page.getByRole("button", { name: "Scan card", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText(english);
        await expectInBothLanguages(page, arabic);
      });
    }
  });
}
