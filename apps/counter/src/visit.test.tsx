import { formatCardQr, type DeviceCatalog } from "@cafe-loyalty/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getMeta, listQueued, setMeta } from "./storage.js";
import { CAFE, envelope, fakeApi, staffEntry, storePairedDevice } from "./test-helpers.js";
import { CounterScreen, cafeClock } from "./visit.js";

/** What the camera "sees" next; the real scanner needs a camera, which tests do not have. */
let nextScan = "";
vi.mock("./scanner.js", () => ({
  QrScanner: ({ onScan, onCancel }: { onScan: (text: string) => void; onCancel: () => void }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          onScan(nextScan);
        }}
      >
        Camera sees a code
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  ),
}));

const COFFEE = { id: "3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f", nameAr: "قهوة", nameEn: "Coffee", priceCents: 300, costCents: 90, stampsEarned: 1 };
const CAKE = { id: "4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a", nameAr: "كيك", nameEn: "Cake", priceCents: 450, costCents: 150, stampsEarned: 0 };
const CATALOG: DeviceCatalog = {
  catalogVersion: 4,
  timeZone: "Asia/Beirut",
  campaigns: [],
  winBackOffers: [],
  orderTypes: [COFFEE, CAKE],
  program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" },
};
/** Half off coffee on Mondays 15:00-17:00 in Beirut, keeping 30% over cost. */
const QUIET = {
  id: "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c",
  nameAr: "ساعات هادئة",
  nameEn: "Quiet hours",
  weekdays: [1],
  startsMinute: 15 * 60,
  endsMinute: 17 * 60,
  discount: { kind: "percent" as const, value: 50 },
  minMarginPercent: 30,
  orderTypeIds: [COFFEE.id],
};
const cardOf = (cafeId: string) => formatCardQr({ cardId: "5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b", cafeId, epoch: 1, keyId: "q1" }, "M".repeat(43));

async function counter(options: { online?: boolean; catalog?: DeviceCatalog } = {}) {
  const { device } = await storePairedDevice();
  const barista = await staffEntry("2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "Rami", "482913");
  const onBusy = vi.fn();
  render(<CounterScreen device={device} barista={barista} catalog={options.catalog ?? CATALOG} online={options.online ?? true} onBusy={onBusy} />);
  return { device, barista, onBusy };
}

describe("visits", () => {
  it("records what was ordered, priced as the menu shows it, for a phone number (AC 22, 32)", async () => {
    const { barista, onBusy } = await counter();
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.click(screen.getByRole("button", { name: "One more Cake" }));
    expect(screen.getByText("Total $10.50 · 2 stamps")).toBeInTheDocument();
    await waitFor(() => {
      expect(onBusy).toHaveBeenLastCalledWith(true);
    });
    fireEvent.change(screen.getByLabelText("Or the customer's mobile number"), { target: { value: "70 123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    expect(await screen.findByText("Visit saved, earning up to 2 stamps. It is sent as soon as the phone is online.")).toBeInTheDocument();
    const [queued] = await listQueued(10);
    expect(queued?.event).toMatchObject({
      type: "visit.recorded",
      schemaVersion: 3,
      staffId: barista.id,
      payload: {
        card: { kind: "phone", phone: "+96170123456" },
        items: [
          { orderTypeId: COFFEE.id, quantity: 2, unitPriceCents: 300, unitCostCents: 90, catalogVersion: 4, campaignId: null, unitDiscountCents: 0 },
          { orderTypeId: CAKE.id, quantity: 1, unitPriceCents: 450, unitCostCents: 150, catalogVersion: 4, campaignId: null, unitDiscountCents: 0 },
        ],
        totalCents: 1050,
      },
    });
    // The order is closed: nothing typed, nothing chosen, so the app may update again.
    expect(screen.getByLabelText("Or the customer's mobile number")).toHaveValue("");
    await waitFor(() => {
      expect(onBusy).toHaveBeenLastCalledWith(false);
    });
  });

  it("gives a running campaign's discount, and records the visit as priced on screen even if the campaign ends before the tap (AC 35)", async () => {
    // Monday 12 October 2026, 16:59:50 in Beirut (UTC+3): ten seconds before the campaign ends.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-12T13:59:50Z") });
    try {
      await counter({ catalog: { ...CATALOG, campaigns: [QUIET] } });
      expect(screen.getByText("$1.50 (Quiet hours)", { exact: false })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
      fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
      fireEvent.click(screen.getByRole("button", { name: "One more Cake" }));
      expect(screen.getByText("Total $7.50 · 2 stamps")).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Or the customer's mobile number"), { target: { value: "70 123 456" } });
      // The campaign ends before the barista taps Record: the total read out and charged stands.
      vi.setSystemTime(new Date("2026-10-12T14:00:10Z"));
      fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
      await screen.findByText(/^Visit saved/);
      const [queued] = await listQueued(10);
      expect(queued?.event).toMatchObject({
        schemaVersion: 3,
        occurredAt: "2026-10-12T13:59:50.000Z",
        payload: {
          items: [
            { orderTypeId: COFFEE.id, quantity: 2, unitPriceCents: 300, campaignId: QUIET.id, unitDiscountCents: 150 },
            { orderTypeId: CAKE.id, quantity: 1, unitPriceCents: 450, campaignId: null, unitDiscountCents: 0 },
          ],
          totalCents: 750,
          winBack: false,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /** Scans this café's test card, whose id is in cardOf. */
  const scanCard = () => {
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
  };
  const SCANNED_CARD = "5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b";

  it("offers a scanned card's win-back offer with its own terms, taking the larger discount and keeping each margin floor (AC 36)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-12T13:30:00Z") });
    try {
      // 60% off: coffee keeps its floor ($1.20 against $1.17), cake does not ($1.80 against $1.95), so cake stays full price.
      const offer = { cardId: SCANNED_CARD, discount: { kind: "percent" as const, value: 60 }, minMarginPercent: 30 };
      await counter({ catalog: { ...CATALOG, campaigns: [QUIET], winBackOffers: [offer] } });
      fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
      fireEvent.click(screen.getByRole("button", { name: "One more Cake" }));
      expect(screen.queryByRole("checkbox", { name: /win-back offer/ })).toBeNull();
      scanCard();
      expect(screen.getByText("Total $6.00 · 1 stamp")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox", { name: "This card has a win-back offer, 60% off: apply it" }));
      // Coffee: 60% ($1.80) beats the campaign's 50%; cake: no win-back discount below its floor.
      expect(screen.getByText("$1.20 (Win-back offer)", { exact: false })).toBeInTheDocument();
      expect(screen.getByText("Total $5.70 · 1 stamp")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
      await screen.findByText(/^Visit saved/);
      const [queued] = await listQueued(10);
      expect(queued?.event).toMatchObject({
        schemaVersion: 3,
        payload: {
          items: [
            { orderTypeId: COFFEE.id, campaignId: null, unitDiscountCents: 180 },
            { orderTypeId: CAKE.id, campaignId: null, unitDiscountCents: 0 },
          ],
          totalCents: 570,
          winBack: true,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the campaign's discount where it is larger, and says when the offer takes nothing off the order (AC 36)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-12T13:30:00Z") });
    try {
      // 10% off coffee ($0.30) loses to the campaign's 50% ($1.50).
      const offer = { cardId: SCANNED_CARD, discount: { kind: "percent" as const, value: 10 }, minMarginPercent: 30 };
      await counter({ catalog: { ...CATALOG, campaigns: [QUIET], winBackOffers: [offer] } });
      fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
      scanCard();
      fireEvent.click(screen.getByRole("checkbox", { name: /This card has a win-back offer, 10% off/ }));
      expect(screen.getByText("$1.50 (Quiet hours)", { exact: false })).toBeInTheDocument();
      expect(screen.getByText(/The offer takes nothing off this order/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
      await screen.findByText(/^Visit saved/);
      const [queued] = await listQueued(10);
      expect(queued?.event).toMatchObject({ payload: { items: [{ campaignId: QUIET.id, unitDiscountCents: 150 }], totalCents: 150 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no win-back offer for a card without one, nor for a card typed in by phone number", async () => {
    await counter({ catalog: { ...CATALOG, winBackOffers: [{ cardId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", discount: { kind: "percent", value: 20 }, minMarginPercent: 0 }] } });
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    scanCard();
    expect(screen.queryByRole("checkbox", { name: /win-back offer/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear card" }));
    fireEvent.change(screen.getByLabelText("Or the customer's mobile number"), { target: { value: "70 123 456" } });
    expect(screen.queryByRole("checkbox", { name: /win-back offer/ })).toBeNull();
  });

  it("gives a fixed amount off, and says which price was and which is now", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-12T13:30:00Z") });
    try {
      await counter({ catalog: { ...CATALOG, campaigns: [{ ...QUIET, discount: { kind: "amount", value: 50 } }] } });
      expect(screen.getByText("was", { exact: false, selector: ".visually-hidden" })).toBeInTheDocument();
      expect(screen.getByText("now", { exact: false, selector: ".visually-hidden" })).toBeInTheDocument();
      expect(screen.getByText("$2.50 (Quiet hours)", { exact: false })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
      expect(screen.getByText("Total $2.50 · 1 stamp")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives no discount outside the campaign's hours, or one that would sell below its margin floor", async () => {
    // Monday 18:00 in Beirut: after the campaign's hours.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-12T15:00:00Z") });
    try {
      await counter({ catalog: { ...CATALOG, campaigns: [QUIET, { ...QUIET, id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", startsMinute: 0, endsMinute: 1440, minMarginPercent: 300 }] } });
      fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
      expect(screen.getByText("Total $3.00 · 1 stamp")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the café's clock across Beirut's spring changeover, and gives up on a time zone it cannot read", () => {
    expect(cafeClock(new Date("2026-03-28T21:59:00Z"), "Asia/Beirut")).toEqual({ weekday: 6, minute: 23 * 60 + 59 });
    expect(cafeClock(new Date("2026-03-28T22:00:00Z"), "Asia/Beirut")).toEqual({ weekday: 7, minute: 60 });
    expect(cafeClock(new Date(), "Not/A_Zone")).toBeNull();
  });

  it("asks for a card and a valid number before saving, tying a bad number to its field", async () => {
    await counter();
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Scan the customer's card, or enter their mobile number.");
    const field = screen.getByLabelText("Or the customer's mobile number");
    expect(field).not.toHaveAttribute("aria-invalid");
    fireEvent.change(field, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a Lebanese mobile number");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Enter a Lebanese mobile number, such as 70 123 456.");
    expect(await listQueued(10)).toEqual([]);
  });

  it("keeps the keyboard on a stepper at its limit, where it changes nothing", async () => {
    await counter();
    const less = screen.getByRole("button", { name: "One less Coffee" });
    less.focus();
    expect(less).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(less);
    expect(less).toHaveFocus();
    expect(screen.getByText("Total $0.00 · 0 stamps")).toBeInTheDocument();
  });

  it("names what the owner took off sale while the order was open, and leaves it out", async () => {
    const { device } = await storePairedDevice();
    const barista = await staffEntry("2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "Rami", "482913");
    const props = { device, barista, online: true, onBusy: vi.fn() };
    const { rerender } = render(<CounterScreen {...props} catalog={CATALOG} />);
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.click(screen.getByRole("button", { name: "One more Cake" }));
    rerender(<CounterScreen {...props} catalog={{ ...CATALOG, orderTypes: [COFFEE] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("No longer on sale, so left out of this order: Cake. The total does not include it.");
    expect(screen.getByText("Total $3.00 · 1 stamp")).toBeInTheDocument();
  });

  it("takes this café's scanned card and refuses another café's or a code that is not a card", async () => {
    await counter();
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    for (const [code, problem] of [
      [cardOf("0f0f0f0f-0000-4000-8000-000000000000"), "That card is for another café."],
      ["https://example.com/menu", "That QR code is not a loyalty card."],
    ] as const) {
      nextScan = code;
      fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
      fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
      expect(screen.getByRole("alert")).toHaveTextContent(problem);
    }
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    expect(screen.getByText(/Card scanned/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    await waitFor(async () => {
      expect((await listQueued(10))[0]?.event).toMatchObject({ payload: { card: { kind: "qr", token: cardOf(CAFE.id) } } });
    });
  });
});

describe("rewards", () => {
  it("are refused offline with a clear message (AC 31)", async () => {
    await counter({ online: false });
    expect(screen.getByText("Rewards need an internet connection. Connect the phone, then try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan card for a reward" })).toBeDisabled();
  });

  it("are given for a scanned card, and a retry after a lost answer reuses the same redemption (AC 31)", async () => {
    const { onBusy } = await counter();
    let lose = true;
    const calls = fakeApi((call) => {
      if (lose) {
        lose = false;
        throw new TypeError("Failed to fetch");
      }
      expect(call.path).toBe("/api/device/redemptions");
      return { status: 201, body: { stampsUsed: 9, stampsLeft: 1, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" } };
    });
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card for a reward" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^The reward started at .+ was not confirmed\. Do not give it yet: check the connection, then press Try again\.$/);
    // The keyboard lands on the next step.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
    });
    // Kept on the phone and marked busy, so neither a reload nor an update loses it.
    expect(await getMeta("pendingRedemption")).toMatchObject({ cardQr: cardOf(CAFE.id) });
    // The busy flag passes through two effects (the panel's, then the screen's).
    await waitFor(() => {
      expect(onBusy).toHaveBeenLastCalledWith(true);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });
    expect(await screen.findByText("Reward given: Free coffee. 1 stamp left on the card.")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Scan card for a reward" })).toHaveFocus();
    });
    expect(await getMeta("pendingRedemption")).toBeUndefined();
    await waitFor(() => {
      expect(onBusy).toHaveBeenLastCalledWith(false);
    });
    const bodies = calls.map((call) => call.body as { eventId: string; cardQr: string });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.eventId).toBe(bodies[0]?.eventId);
    expect(bodies[0]?.cardQr).toBe(cardOf(CAFE.id));
  });

  it("must try an unconfirmed one again after a reload, with the same event id, saying which one it was", async () => {
    const startedAt = "2026-10-09T08:42:00.000Z";
    const shown = new Intl.DateTimeFormat("en-GB", { timeStyle: "short" }).format(new Date(startedAt));
    await setMeta("pendingRedemption", { eventId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", cardQr: cardOf(CAFE.id), startedAt });
    await counter();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(`A reward started at ${shown} was not confirmed.`);
    expect(screen.queryByRole("button", { name: "Scan card for a reward" })).not.toBeInTheDocument();
    const calls = fakeApi(() => ({ status: 200, body: { stampsUsed: 9, stampsLeft: 0, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" } }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(`The earlier reward, started at ${shown}, was given: Free coffee. 0 stamps left on that card. If that customer did not get it, tell the owner.`),
    ).toBeInTheDocument();
    expect(calls[0]?.body).toMatchObject({ eventId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d" });
  });

  it("show why the server refused one", async () => {
    await counter();
    fakeApi(() => ({ status: 409, body: envelope("CONFLICT", "This card has 4 of the 9 stamps a reward needs. Add stamps first.") }));
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card for a reward" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This card has 4 of the 9 stamps a reward needs.");
    expect(screen.getByRole("button", { name: "Scan card for a reward" })).toBeEnabled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Scan card for a reward" })).toHaveFocus();
    });
  });
});
