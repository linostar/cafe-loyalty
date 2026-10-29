import { formatCardQr, type DeviceCatalog } from "@cafe-loyalty/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getMeta, listQueued, setMeta } from "./storage.js";
import { CAFE, envelope, fakeApi, staffEntry, storePairedDevice } from "./test-helpers.js";
import { LangProvider } from "./i18n.js";
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
  it("keeps the phone number left to right in Arabic, and its example in reading order", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["ar-LB"]);
    const { device } = await storePairedDevice();
    const barista = await staffEntry("2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "Rami", "482913");
    render(
      <LangProvider>
        <CounterScreen device={device} barista={barista} catalog={CATALOG} online onBusy={vi.fn()} />
      </LangProvider>,
    );
    const phone = screen.getByLabelText("لا بطاقة؟ رقم هاتف الزبون المحمول");
    // Digits typed into a right-to-left page would otherwise show their groups right to left ("456 123 70").
    expect(phone).toHaveAttribute("dir", "ltr");
    fireEvent.click(screen.getByRole("button", { name: /^زيادة .*قهوة/ }));
    fireEvent.change(phone, { target: { value: "70 12" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الزيارة" }));
    // The example number sits in left-to-right isolates.
    expect(await screen.findByRole("alert")).toHaveTextContent("مثل ⁦70 123 456⁩.");
  });

  it("says an offline visit is sent once the phone is online", async () => {
    await counter({ online: false });
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.change(screen.getByLabelText("No card? The customer's mobile number"), { target: { value: "70 123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    expect(await screen.findByText("Visit saved, earning up to 1 stamp. It is sent as soon as the phone is online.")).toBeInTheDocument();
  });

  it("says the connection as it is when the save completes, not when Record was tapped", async () => {
    const { device } = await storePairedDevice();
    const barista = await staffEntry("2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "Rami", "482913");
    const props = { device, barista, catalog: CATALOG, onBusy: vi.fn() };
    const { rerender } = render(<CounterScreen {...props} online />);
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.change(screen.getByLabelText("No card? The customer's mobile number"), { target: { value: "70 123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    // The save (IndexedDB) is still pending: the phone goes offline meanwhile.
    rerender(<CounterScreen {...props} online={false} />);
    expect(await screen.findByText("Visit saved, earning up to 1 stamp. It is sent as soon as the phone is online.")).toBeInTheDocument();
  });

  it("records what was ordered, priced as the menu shows it, for a phone number (AC 22, 32)", async () => {
    const { barista, onBusy } = await counter();
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.click(screen.getByRole("button", { name: "One more Cake" }));
    expect(screen.getByText("Total $10.50 · 2 stamps")).toBeInTheDocument();
    await waitFor(() => {
      expect(onBusy).toHaveBeenLastCalledWith(true);
    });
    fireEvent.change(screen.getByLabelText("No card? The customer's mobile number"), { target: { value: "70 123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    expect(await screen.findByText("Visit saved, earning up to 2 stamps. Sending it now.")).toBeInTheDocument();
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
    expect(screen.getByLabelText("No card? The customer's mobile number")).toHaveValue("");
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
      fireEvent.change(screen.getByLabelText("No card? The customer's mobile number"), { target: { value: "70 123 456" } });
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
      expect(screen.queryByRole("checkbox", { name: /welcome-back offer/ })).toBeNull();
      scanCard();
      expect(screen.getByText("Total $6.00 · 1 stamp")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox", { name: "Apply the welcome-back offer: 60% off" }));
      // Coffee: 60% ($1.80) beats the campaign's 50%; cake: no win-back discount below its floor.
      expect(screen.getByText("$1.20 (Welcome-back offer)", { exact: false })).toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("checkbox", { name: "Apply the welcome-back offer: 10% off" }));
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
    expect(screen.queryByRole("checkbox", { name: /welcome-back offer/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear card" }));
    fireEvent.change(screen.getByLabelText("No card? The customer's mobile number"), { target: { value: "70 123 456" } });
    expect(screen.queryByRole("checkbox", { name: /welcome-back offer/ })).toBeNull();
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
    const field = screen.getByLabelText("No card? The customer's mobile number");
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
    // Once the phone has been checked for an unconfirmed reward.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Scan card for a reward" })).toBeEnabled();
    });
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
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Scan card for a reward" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Scan card for a reward" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This card has 4 of the 9 stamps a reward needs.");
    expect(screen.getByRole("button", { name: "Scan card for a reward" })).toBeEnabled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Scan card for a reward" })).toHaveFocus();
    });
  });
});

describe("the counter's speed and recovery (phase 2)", () => {
  const record = () => {
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.change(screen.getByLabelText("No card? The customer's mobile number"), { target: { value: "70 123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
  };

  it("shows a saved visit in the success style and buzzes, then undoes it while unsent, putting the order back (K2, K4)", async () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    try {
      await counter({ online: false });
      record();
      const saved = await screen.findByText("Visit saved, earning up to 1 stamp. It is sent as soon as the phone is online.");
      expect(saved).toHaveClass("saved");
      expect(vibrate).toHaveBeenCalledWith(50);
      const [queued] = await listQueued(10);
      expect(queued?.holdUntil).toBeGreaterThan(Date.now());
      // Said too, for those who do not see the button come.
      expect(screen.getByText("It can be undone for 10 seconds.")).toHaveAttribute("role", "status");
      fireEvent.click(screen.getByRole("button", { name: "Undo the visit" }));
      expect(await screen.findByText("Visit undone. Change the order and record it again.")).not.toHaveClass("saved");
      expect(screen.queryByText("It can be undone for 10 seconds.")).not.toBeInTheDocument();
      expect(await listQueued(10)).toEqual([]);
      // As it was recorded: one coffee, for that number.
      expect(screen.getByText("Total $3.00 · 1 stamp")).toBeInTheDocument();
      expect(screen.getByLabelText("No card? The customer's mobile number")).toHaveValue("70 123 456");
      expect(screen.queryByRole("button", { name: "Undo the visit" })).not.toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Record visit" })).toHaveFocus();
      });
    } finally {
      Reflect.deleteProperty(navigator, "vibrate");
    }
  });

  it("says it is too late once the visit's hold has passed, and keeps it queued (K2)", async () => {
    await counter({ online: false });
    record();
    await screen.findByRole("button", { name: "Undo the visit" });
    // The tap lands just as the hold ends (the button goes a moment later).
    const later = Date.now() + 11_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Undo the visit" }));
      expect(await screen.findByText("Too late to undo: the visit is sent or on its way. Tell the owner, who can fix it in Review.")).toBeInTheDocument();
    } finally {
      now.mockRestore();
    }
    expect(await listQueued(10)).toHaveLength(1);
    expect(screen.getByText("Total $0.00 · 0 stamps")).toBeInTheDocument();
  });

  it("ends the Undo offer when the next order starts", async () => {
    await counter({ online: false });
    record();
    await screen.findByRole("button", { name: "Undo the visit" });
    fireEvent.click(screen.getByRole("button", { name: "One more Cake" }));
    expect(screen.queryByRole("button", { name: "Undo the visit" })).not.toBeInTheDocument();
  });

  it("shows a typed number as it will be recorded, before Record (K10)", async () => {
    await counter();
    const phone = screen.getByLabelText("No card? The customer's mobile number");
    fireEvent.change(phone, { target: { value: "70123456" } });
    expect(phone).toHaveAccessibleDescription("Records it for ⁦+961 70 123 456⁩.");
    fireEvent.change(phone, { target: { value: "03 123 456" } });
    expect(phone).toHaveAccessibleDescription("Records it for ⁦+961 3 123 456⁩.");
    // Not a number yet: nothing to read back.
    fireEvent.change(phone, { target: { value: "70 12" } });
    expect(screen.queryByText(/^Records it for/)).not.toBeInTheDocument();
  });

  it("says why the last visit the server settled got no stamps (K1)", async () => {
    const { device } = await storePairedDevice();
    const barista = await staffEntry("2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "Rami", "482913");
    const props = { device, barista, catalog: CATALOG, online: true, onBusy: vi.fn() };
    const occurredAt = "2026-10-01T08:00:00.000Z";
    const { rerender } = render(<CounterScreen {...props} lastVisit={{ eventId: "e1", occurredAt, code: "STAMP_COOLDOWN" }} />);
    expect(screen.getByText(/^Last visit, at .+: recorded with no stamps, because the card got stamps less than 30 minutes before\.$/)).toBeInTheDocument();
    rerender(<CounterScreen {...props} lastVisit={{ eventId: "e2", occurredAt, code: "DAILY_STAMP_CAP" }} />);
    expect(screen.getByText(/this phone reached its stamps for today\. Tell the owner\.$/)).toBeInTheDocument();
    rerender(<CounterScreen {...props} lastVisit={{ eventId: "e5", occurredAt, code: "CARD_GONE" }} />);
    expect(screen.getByText(/recorded with no stamps, because the card was deleted\.$/)).toBeInTheDocument();
    rerender(<CounterScreen {...props} lastVisit={{ eventId: "e3", occurredAt, code: "HELD_FOR_REVIEW" }} />);
    expect(screen.getByText(/held for the owner to check; its stamps wait until the owner accepts it\.$/)).toBeInTheDocument();
    rerender(<CounterScreen {...props} lastVisit={{ eventId: "e4", occurredAt, code: "OK" }} />);
    expect(screen.getByText(/^Last visit, at .+: recorded\.$/)).toBeInTheDocument();
  });

  it("offers a scanned card's ready reward and gives it with the same scan, saying so in the order (K6)", async () => {
    await counter();
    const card = cardOf(CAFE.id);
    const calls = fakeApi((call) =>
      call.path === "/api/device/cards/status"
        ? { status: 200, body: { stamps: 9, rewardReady: true } }
        : { status: 201, body: { stampsUsed: 9, stampsLeft: 0, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" } },
    );
    nextScan = card;
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    // Shown, and announced: focus is on Record visit, after it.
    const [shown, said] = await screen.findAllByText("Reward ready: Free coffee.");
    expect(shown?.closest(".reward-ready")).not.toBeNull();
    expect(said).toHaveAttribute("role", "status");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/device/cards/status", body: { cardQr: card } });
    fireEvent.click(screen.getByRole("button", { name: "Give Free coffee now" }));
    // The button goes; the keyboard moves on to the next step instead of the page.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Record visit" })).toHaveFocus();
    });
    expect(await screen.findByText("Reward given: Free coffee. 0 stamps left on the card.")).toHaveClass("saved");
    expect(calls[1]).toMatchObject({ path: "/api/device/redemptions", body: { cardQr: card } });
    expect(screen.queryByText("Reward ready: Free coffee.")).not.toBeInTheDocument();
    // The visit is still to record, for the same card.
    expect(screen.getByText("Card scanned.")).toBeInTheDocument();
  });

  it("offers a reward only from this scan's check, not an earlier one's (K6)", async () => {
    await counter();
    let ready = true;
    const calls = fakeApi(() => ({ status: 200, body: { stamps: ready ? 9 : 0, rewardReady: ready } }));
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    expect(await screen.findAllByText("Reward ready: Free coffee.")).toHaveLength(2);
    // Given meanwhile (on the reward panel, or another phone): the same card's next scan is told it is not ready.
    ready = false;
    fireEvent.click(screen.getByRole("button", { name: "Clear card" }));
    expect(screen.queryByText("Reward ready: Free coffee.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    expect(await screen.findByText("Card scanned.")).toBeInTheDocument();
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(screen.queryByText("Reward ready: Free coffee.")).not.toBeInTheDocument();
  });

  it("keeps Give now off while the reward panel scans, so one redemption runs at a time", async () => {
    await counter();
    fakeApi(() => ({ status: 200, body: { stamps: 9, rewardReady: true } }));
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    const give = await screen.findByRole("button", { name: "Give Free coffee now" });
    fireEvent.click(screen.getByRole("button", { name: "Scan card for a reward" }));
    expect(give).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(give).toBeEnabled();
  });

  it("ignores a slow answer for an earlier scan of the same card (K6)", async () => {
    await counter();
    let answerFirst: (ready: boolean) => void = () => undefined;
    const answers = [
      new Promise<boolean>((resolve) => {
        answerFirst = resolve;
      }),
      Promise.resolve(false),
    ];
    const calls = fakeApi(async () => {
      const ready = await answers[calls.length - 1];
      return { status: 200, body: { stamps: ready === true ? 9 : 0, rewardReady: ready === true } };
    });
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear card" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    // The first scan's answer comes last, saying ready: the card scanned now was answered not ready.
    answerFirst(true);
    await act(async () => {
      await answers[0];
    });
    expect(screen.queryByText("Reward ready: Free coffee.")).not.toBeInTheDocument();
  });

  it("keeps Give now off while the phone is offline, as rewards need the server", async () => {
    const { device } = await storePairedDevice();
    const barista = await staffEntry("2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "Rami", "482913");
    const { rerender } = render(<CounterScreen device={device} barista={barista} catalog={CATALOG} online onBusy={vi.fn()} />);
    fakeApi(() => ({ status: 200, body: { stamps: 9, rewardReady: true } }));
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    const give = await screen.findByRole("button", { name: "Give Free coffee now" });
    rerender(<CounterScreen device={device} barista={barista} catalog={CATALOG} online={false} onBusy={vi.fn()} />);
    expect(give).toBeDisabled();
  });

  it("announces a refused reward asked for from the visit once, showing it beside Try again too", async () => {
    await counter();
    fakeApi((call) =>
      call.path === "/api/device/cards/status"
        ? { status: 200, body: { stamps: 9, rewardReady: true } }
        : { status: 404, body: envelope("NOT_FOUND", "This is not a loyalty card of this café.") },
    );
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Give Free coffee now" }));
    expect(await screen.findAllByText("This is not a loyalty card of this café.")).toHaveLength(2);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("offers no reward for a card short of it", async () => {
    await counter();
    const calls = fakeApi(() => ({ status: 200, body: { stamps: 4, rewardReady: false } }));
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(screen.queryByText(/^Reward ready/)).not.toBeInTheDocument();
  });

  it("asks nothing about the reward offline", async () => {
    await counter({ online: false });
    const calls = fakeApi(() => ({ status: 200, body: { stamps: 9, rewardReady: true } }));
    nextScan = cardOf(CAFE.id);
    fireEvent.click(screen.getByRole("button", { name: "Scan card" }));
    fireEvent.click(screen.getByRole("button", { name: "Camera sees a code" }));
    expect(await screen.findByText("Card scanned.")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("keeps the screen on while the counter shows, asking again when the page shows again (K13)", async () => {
    const sentinels: { release: () => Promise<void> }[] = [];
    const request = vi.fn(() => {
      const sentinel = { release: vi.fn(() => Promise.resolve()) };
      sentinels.push(sentinel);
      return Promise.resolve(sentinel);
    });
    Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    try {
      await counter();
      await waitFor(() => {
        expect(request).toHaveBeenCalledWith("screen");
      });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(request).toHaveBeenCalledTimes(2);
      // Only the latest lock is kept: the first is let go once the second is held.
      await waitFor(() => {
        expect(sentinels[0]?.release).toHaveBeenCalled();
      });
      expect(sentinels[1]?.release).not.toHaveBeenCalled();
      cleanup();
      expect(sentinels[1]?.release).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "wakeLock");
    }
  });

  it("clears an open order nobody touched for 5 minutes, and says so (K3)", async () => {
    await counter({ online: false });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
      act(() => {
        vi.advanceTimersByTime(5 * 60 * 1000 - 1);
      });
      expect(screen.getByText("Total $3.00 · 1 stamp")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByText("Total $0.00 · 0 stamps")).toBeInTheDocument();
      expect(screen.getByText("The open order was cleared after 5 minutes without use.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts only changes to the order as touching it: each restarts its 5 minutes, other use does not (K3)", async () => {
    await counter({ online: false });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
      act(() => {
        vi.advanceTimersByTime(4 * 60 * 1000);
      });
      fireEvent.change(screen.getByLabelText("No card? The customer's mobile number"), { target: { value: "70 1" } });
      act(() => {
        vi.advanceTimersByTime(4 * 60 * 1000);
      });
      expect(screen.getByText("Total $3.00 · 1 stamp")).toBeInTheDocument();
      // Using the rest of the counter (the reward panel, a tap elsewhere) leaves the order as untouched as it was.
      fireEvent.pointerDown(document.body);
      fireEvent.keyDown(document.body, { key: "Tab" });
      act(() => {
        vi.advanceTimersByTime(60 * 1000);
      });
      expect(screen.getByText("Total $0.00 · 0 stamps")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
