import { formatCardQr, type DeviceCatalog } from "@cafe-loyalty/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import * as storage from "./storage.js";
import { CAFE, fakeApi, staffEntry, storePairedDevice } from "./test-helpers.js";
import { CounterScreen } from "./visit.js";

/** The phone's storage failing on demand (AC 42: such failures are said, never only logged). */
vi.mock("./storage.js", async (actual) => {
  const real = await actual<typeof storage>();
  return { ...real, getMeta: vi.fn(real.getMeta), deleteMeta: vi.fn(real.deleteMeta) };
});
vi.mock("./updates.js", () => ({ useServiceWorkerUpdate: vi.fn(() => ({ waiting: false, error: null })) }));
let nextScan = "";
vi.mock("./scanner.js", () => ({
  QrScanner: ({ onScan }: { onScan: (text: string) => void }) => (
    <button
      type="button"
      onClick={() => {
        onScan(nextScan);
      }}
    >
      Camera sees a code
    </button>
  ),
}));

const CATALOG: DeviceCatalog = {
  catalogVersion: 4,
  timeZone: "Asia/Beirut",
  campaigns: [],
  winBackOffers: [],
  orderTypes: [{ id: "3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f", nameAr: "قهوة", nameEn: "Coffee", priceCents: 300, costCents: 90, stampsEarned: 1 }],
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
};
const CARD = formatCardQr({ cardId: "5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b", cafeId: CAFE.id, epoch: 1, keyId: "q1" }, "M".repeat(43));

async function counter() {
  const { device } = await storePairedDevice();
  const barista = await staffEntry("2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "Rami", "482913");
  render(<CounterScreen device={device} barista={barista} catalog={CATALOG} online onBusy={vi.fn()} />);
}

afterEach(() => {
  vi.mocked(storage.getMeta).mockRestore();
  vi.mocked(storage.deleteMeta).mockRestore();
});

describe("when the phone's storage fails", () => {
  it("says an unconfirmed reward may be waiting when it cannot be read", async () => {
    vi.mocked(storage.getMeta).mockRejectedValue(new Error("storage broke"));
    await counter();
    expect(await screen.findByRole("alert")).toHaveTextContent("This phone's storage could not be read, so an unconfirmed reward may be waiting.");
  });

  it("warns not to give a reward twice when it cannot forget one already given", async () => {
    await counter();
    vi.mocked(storage.deleteMeta).mockRejectedValue(new Error("storage broke"));
    fakeApi(() => ({ status: 201, body: { stampsUsed: 9, stampsLeft: 1, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" } }));
    nextScan = CARD;
    fireEvent.click(screen.getByRole("button", { name: "Scan card for a reward" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    // The answer stays in the warning, now an alert rather than a confirmation.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Reward given: Free coffee\. 1 stamp left on the card\. This phone could not forget the reward/);
    expect(alert).toHaveTextContent("do not give it twice.");
  });

  it("says another tab holds the storage, and how to free it, rather than a generic failure", async () => {
    vi.mocked(storage.getMeta).mockRejectedValue(new Error(storage.STORAGE_BUSY));
    render(<App />);
    expect(await screen.findByText("This phone's storage is busy in another tab. Close the other counter tabs and reload.")).toBeInTheDocument();
  });
});

describe("a message on screen", () => {
  it("follows a language switch", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    vi.mocked(storage.getMeta).mockRejectedValue(new Error(storage.STORAGE_BUSY));
    render(<App />);
    expect(await screen.findByText("This phone's storage is busy in another tab. Close the other counter tabs and reload.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "العربية" }));
    expect(await screen.findByText("تخزين هذا الهاتف مشغول في تبويب آخر. أغلق تبويبات الكاونتر الأخرى وأعد التحميل.")).toBeInTheDocument();
  });
});
