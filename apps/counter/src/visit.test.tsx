import { formatCardQr, type DeviceCatalog } from "@cafe-loyalty/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getMeta, listQueued, setMeta } from "./storage.js";
import { CAFE, envelope, fakeApi, staffEntry, storePairedDevice } from "./test-helpers.js";
import { CounterScreen } from "./visit.js";

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
const CATALOG: DeviceCatalog = { catalogVersion: 4, orderTypes: [COFFEE, CAKE], program: { stampsRequired: 9, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" } };
const cardOf = (cafeId: string) => formatCardQr({ cardId: "5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b", cafeId, epoch: 1, keyId: "q1" }, "M".repeat(43));

async function counter(options: { online?: boolean } = {}) {
  const { device } = await storePairedDevice();
  const barista = await staffEntry("2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e", "Rami", "482913");
  const onBusy = vi.fn();
  render(<CounterScreen device={device} barista={barista} catalog={CATALOG} online={options.online ?? true} onBusy={onBusy} />);
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
      schemaVersion: 1,
      staffId: barista.id,
      payload: {
        card: { kind: "phone", phone: "+96170123456" },
        items: [
          { orderTypeId: COFFEE.id, quantity: 2, unitPriceCents: 300, unitCostCents: 90, catalogVersion: 4 },
          { orderTypeId: CAKE.id, quantity: 1, unitPriceCents: 450, unitCostCents: 150, catalogVersion: 4 },
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

  it("asks for a card and a valid number before saving", async () => {
    await counter();
    fireEvent.click(screen.getByRole("button", { name: "One more Coffee" }));
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Scan the customer's card, or enter their mobile number.");
    fireEvent.change(screen.getByLabelText("Or the customer's mobile number"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Record visit" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a Lebanese mobile number");
    expect(await listQueued(10)).toEqual([]);
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
    expect(await screen.findByRole("alert")).toHaveTextContent("The reward was not confirmed");
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
    expect(await getMeta("pendingRedemption")).toBeUndefined();
    await waitFor(() => {
      expect(onBusy).toHaveBeenLastCalledWith(false);
    });
    const bodies = calls.map((call) => call.body as { eventId: string; cardQr: string });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.eventId).toBe(bodies[0]?.eventId);
    expect(bodies[0]?.cardQr).toBe(cardOf(CAFE.id));
  });

  it("must try an unconfirmed one again after a reload, with the same event id, before giving another", async () => {
    await setMeta("pendingRedemption", { eventId: "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", cardQr: cardOf(CAFE.id) });
    await counter();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan card for a reward" })).not.toBeInTheDocument();
    const calls = fakeApi(() => ({ status: 200, body: { stampsUsed: 9, stampsLeft: 0, rewardNameAr: "قهوة مجانية", rewardNameEn: "Free coffee" } }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Reward given: Free coffee. 0 stamps left on the card.")).toBeInTheDocument();
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
  });
});
