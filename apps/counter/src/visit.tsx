import {
  bestCampaign,
  formatUsd,
  normalizePhoneInput,
  parseCardQr,
  redemptionSchema,
  visitItemsTotalCents,
  visitRecordedV3PayloadSchema,
  winBackUnitDiscountCents,
  type DeviceCatalog,
  type WinBackOffer,
} from "@cafe-loyalty/shared";
import { useEffect, useId, useRef, useState } from "react";
import { DeviceUnpairedError, RequestError, deviceRequest } from "./device.js";
import { QrScanner } from "./scanner.js";
import { deleteMeta, getMeta, setMeta, type DeviceRecord, type MetaValues, type StaffEntry } from "./storage.js";
import { recordEvent } from "./sync.js";

type CardChoice = { kind: "qr"; token: string } | { kind: "phone"; phone: string };
type StoredRedemption = MetaValues["pendingRedemption"];
/** Which of the counter's two uses of the camera is open; only one at a time. */
type ScanPurpose = "visit" | "reward";

/** A scanned code that is a loyalty card of this café, or why it is not (read offline from the QR itself). */
function readCardQr(text: string, cafeId: string): { token: string } | { problem: string } {
  const fields = parseCardQr(text);
  if (fields === null) {
    return { problem: "That QR code is not a loyalty card. Scan the card the customer shows in their wallet or browser." };
  }
  if (fields.cafeId !== cafeId) {
    return { problem: "That card is for another café. Ask for this café's card, or sign the customer up with the counter QR." };
  }
  return { token: text };
}

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`;

const ISO_WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/**
 * The café's local weekday (ISO) and minute of the day at `at`, from the browser's time zone data: the counter decides
 * discounts offline, and the server checks them again by its own clock (AC 35). Null when the zone cannot be read.
 */
export function cafeClock(at: Date, timeZone: string): { weekday: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
    const weekday = ISO_WEEKDAYS[part("weekday") ?? ""];
    return weekday === undefined ? null : { weekday, minute: Number(part("hour")) * 60 + Number(part("minute")) };
  } catch {
    return null;
  }
}

/** The best running campaign for one order type at `at`, if any (the largest discount that keeps its margin floor). */
export function campaignFor(catalog: DeviceCatalog, type: DeviceCatalog["orderTypes"][number], at: Date) {
  const clock = cafeClock(at, catalog.timeZone);
  return clock === null ? null : bestCampaign(catalog.campaigns, { orderTypeId: type.id, priceCents: type.priceCents, costCents: type.costCents }, clock.weekday, clock.minute);
}

/**
 * One order type's discount at `at`: its best running campaign's (AC 35), or the card's win-back offer's when the
 * barista applied it (`winBack`, the offer's own terms) and it gives more (AC 36). Null without a discount.
 */
export function discountFor(catalog: DeviceCatalog, type: DeviceCatalog["orderTypes"][number], at: Date, winBack: WinBackOffer | null) {
  const campaign = campaignFor(catalog, type, at);
  const offer = winBack === null ? 0 : winBackUnitDiscountCents(type, winBack);
  if (offer > 0 && offer > (campaign?.unitDiscountCents ?? 0)) {
    return { campaignId: null, unitDiscountCents: offer, label: "Win-back offer" };
  }
  return campaign === null ? null : { campaignId: campaign.campaign.id, unitDiscountCents: campaign.unitDiscountCents, label: campaign.campaign.nameEn };
}

/** A discount as the counter says it: "20% off" or "$0.50 off". */
const discountText = (discount: { kind: "percent" | "amount"; value: number }) =>
  discount.kind === "percent" ? `${String(discount.value)}% off` : `${formatUsd(discount.value, "en")} off`;

interface VisitFormProps {
  device: DeviceRecord;
  barista: StaffEntry;
  catalog: DeviceCatalog;
  scanner: ScanPurpose | null;
  onScanner: (purpose: ScanPurpose | null) => void;
  onBusy: (busy: boolean) => void;
}

/** Records a visit offline: what was ordered and whose card, by QR or phone number (AC 22, 30, 32). */
function VisitForm({ device, barista, catalog, scanner, onScanner, onBusy }: VisitFormProps) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  /** The name of everything put in the order, to name it if the owner takes it off sale meanwhile. */
  const [names, setNames] = useState<Record<string, string>>({});
  const [scanned, setScanned] = useState<string | null>(null);
  /** The barista applied the scanned card's win-back offer (AC 36). */
  const [applyWinBack, setApplyWinBack] = useState(false);
  const [phone, setPhone] = useState("");
  /** What is wrong, and whether it is the phone number (then tied to that field). */
  const [problem, setProblem] = useState<{ text: string; phone: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const phoneId = useId();
  const problemId = useId();
  const scanButton = useRef<HTMLButtonElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);

  const items = catalog.orderTypes.filter((type) => (quantities[type.id] ?? 0) > 0).map((type) => ({ type, quantity: quantities[type.id] ?? 0 }));
  // Taken off sale by the owner while this order was open: left out, and said so by name.
  const dropped = Object.entries(quantities)
    .filter(([id, quantity]) => quantity > 0 && !catalog.orderTypes.some((type) => type.id === id))
    .map(([id]) => names[id] ?? "An item");
  const stamps = items.reduce((sum, item) => sum + item.quantity * item.type.stampsEarned, 0);
  /** The scanned card's open win-back offer, from the catalog (a card typed in by phone cannot be matched offline). */
  const scannedCardId = scanned === null ? null : parseCardQr(scanned)?.cardId;
  const offer = catalog.winBackOffers.find((entry) => entry.cardId === scannedCardId) ?? null;
  const winBack = applyWinBack ? offer : null;
  /** The order priced at `at`, with any campaign's or the win-back offer's discount per line (AC 35, 36). */
  const linesAt = (at: Date) =>
    items.map(({ type, quantity }) => {
      const discount = discountFor(catalog, type, at, winBack);
      return {
        orderTypeId: type.id,
        quantity,
        unitPriceCents: type.priceCents,
        unitCostCents: type.costCents,
        catalogVersion: catalog.catalogVersion,
        campaignId: discount?.campaignId ?? null,
        unitDiscountCents: discount?.unitDiscountCents ?? 0,
      };
    });
  // Discounts start and stop with the clock: the open menu is priced again every 30 seconds, and a visit is recorded
  // as priced on screen, at that moment (at most 30 seconds before it is recorded), so it keeps the total the
  // barista read out and charged.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const shownAt = new Date();
  const total = visitItemsTotalCents(linesAt(shownAt));
  // An order in progress: the app must not update under it (AC 29).
  const open = items.length > 0 || scanned !== null || phone !== "" || scanner === "visit";
  useEffect(() => {
    onBusy(open || saving);
  }, [open, saving, onBusy]);

  // Clamped here: the steppers stay focusable at 0 and 50 (aria-disabled), so a click there changes nothing.
  const change = (type: { id: string; nameEn: string }, delta: number) => {
    setNotice("");
    setNames((current) => ({ ...current, [type.id]: type.nameEn }));
    setQuantities((current) => ({ ...current, [type.id]: Math.max(0, Math.min(50, (current[type.id] ?? 0) + delta)) }));
  };

  const record = () => {
    if (saving) {
      return;
    }
    setProblem(null);
    let card: CardChoice;
    if (scanned !== null) {
      card = { kind: "qr", token: scanned };
    } else {
      const e164 = normalizePhoneInput(phone);
      if (e164 === null) {
        setProblem({
          text: phone === "" ? "Scan the customer's card, or enter their mobile number." : "Enter a Lebanese mobile number, such as 70 123 456.",
          phone: phone !== "",
        });
        return;
      }
      card = { kind: "phone", phone: e164 };
    }
    // As shown: the lines and the time they were priced at, so the recorded total is the one on screen.
    const at = shownAt;
    const lines = linesAt(at);
    const payload = visitRecordedV3PayloadSchema.safeParse({ card, items: lines, totalCents: visitItemsTotalCents(lines) ?? -1, winBack: winBack !== null });
    if (!payload.success) {
      setProblem({ text: items.length === 0 ? "Add what the customer ordered first." : "This order is too large to record. Split it into two visits.", phone: false });
      return;
    }
    setSaving(true);
    recordEvent("visit.recorded", 3, barista.id, payload.data, at).then(
      () => {
        setSaving(false);
        setQuantities({});
        setScanned(null);
        setPhone("");
        setApplyWinBack(false);
        // The server decides the stamps (cooldown, daily cap), so the counter promises no more than the order earns.
        setNotice(`Visit saved${stamps > 0 ? `, earning up to ${plural(stamps, "stamp", "stamps")}` : ""}. It is sent as soon as the phone is online.`);
      },
      (caught: unknown) => {
        console.error("Recording the visit failed", caught);
        setSaving(false);
        setProblem({ text: "The visit could not be saved on this phone. Reload the page and record it again.", phone: false });
      },
    );
  };

  if (scanner === "visit") {
    return (
      <section aria-labelledby="scan-title" className="card">
        <h3 id="scan-title">Scan the customer&apos;s card</h3>
        <QrScanner
          purpose="customer's loyalty card QR code"
          noCamera="Enter the customer's mobile number instead."
          onCancel={() => {
            onScanner(null);
            requestAnimationFrame(() => scanButton.current?.focus());
          }}
          onScan={(text) => {
            onScanner(null);
            const read = readCardQr(text, device.cafe.id);
            if ("problem" in read) {
              setProblem({ text: read.problem, phone: false });
              requestAnimationFrame(() => scanButton.current?.focus());
            } else {
              setScanned(read.token);
              setApplyWinBack(false);
              setPhone("");
              setProblem(null);
              // The next step: recording the visit.
              requestAnimationFrame(() => recordButton.current?.focus());
            }
          }}
        />
      </section>
    );
  }

  return (
    <section aria-labelledby="visit-title" className="card visit">
      <h3 id="visit-title">New visit</h3>
      <ul className="menu">
        {catalog.orderTypes.map((type) => {
          const quantity = quantities[type.id] ?? 0;
          const offer = discountFor(catalog, type, shownAt, winBack);
          return (
            <li key={type.id}>
              <span className="menu-item">
                <strong>{type.nameEn}</strong> ·{" "}
                {offer === null ? (
                  formatUsd(type.priceCents, "en")
                ) : (
                  <>
                    <s>
                      <span className="visually-hidden">was </span>
                      {formatUsd(type.priceCents, "en")}
                    </s>{" "}
                    <span className="visually-hidden">now </span>
                    {formatUsd(type.priceCents - offer.unitDiscountCents, "en")} ({offer.label})
                  </>
                )}
                {type.stampsEarned > 0 ? ` · ${plural(type.stampsEarned, "stamp", "stamps")}` : ""}
              </span>
              <span className="stepper">
                <button
                  type="button"
                  aria-label={`One less ${type.nameEn}`}
                  aria-disabled={quantity === 0}
                  onClick={() => {
                    change(type, -1);
                  }}
                >
                  −
                </button>
                <span className={quantity === 0 ? "count" : "count count-chosen"}>{quantity}</span>
                <button
                  type="button"
                  aria-label={`One more ${type.nameEn}`}
                  aria-disabled={quantity === 50}
                  onClick={() => {
                    change(type, 1);
                  }}
                >
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {/* The order beside the menu on a tablet, kept in view as the menu scrolls: total, card and the record button. */}
      <div className="order-summary">
        {dropped.length === 0 ? null : (
          <p role="alert" className="warning-box">
            No longer on sale, so left out of this order: {dropped.join(", ")}. The total does not include {dropped.length === 1 ? "it" : "them"}.
          </p>
        )}
        {offer === null ? null : (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={applyWinBack}
                onChange={(event) => {
                  setApplyWinBack(event.target.checked);
                  setNotice("");
                }}
              />{" "}
              This card has a win-back offer, {discountText(offer.discount)}: apply it
            </label>
            {winBack !== null && items.length > 0 && !linesAt(shownAt).some((line) => line.campaignId === null && line.unitDiscountCents > 0) ? (
              <p role="status">
                The offer takes nothing off this order: a campaign already gives more, or it would sell below the margin floor. The card keeps the offer for its next visit.
              </p>
            ) : null}
          </>
        )}
        <p aria-live="polite" className="total">
          Total {formatUsd(total ?? 0, "en")} · {plural(stamps, "stamp", "stamps")}
        </p>
        <div className="card-choice">
          {scanned === null ? (
            <button
              ref={scanButton}
              type="button"
              disabled={scanner !== null}
              onClick={() => {
                onScanner("visit");
              }}
            >
              Scan card
            </button>
          ) : (
            <p>
              Card scanned.{" "}
              <button
                type="button"
                onClick={() => {
                  setScanned(null);
                  setApplyWinBack(false);
                  // The button that replaces this one keeps the keyboard where it was.
                  requestAnimationFrame(() => scanButton.current?.focus());
                }}
              >
                Clear card
              </button>
            </p>
          )}
          {scanned === null ? (
            <div className="field">
              <label htmlFor={phoneId}>Or the customer&apos;s mobile number</label>
              <input
                id={phoneId}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={phone}
                aria-invalid={problem?.phone === true ? true : undefined}
                aria-describedby={problem?.phone === true ? problemId : undefined}
                onChange={(event) => {
                  setPhone(event.target.value);
                  setNotice("");
                }}
              />
            </div>
          ) : null}
        </div>
        {problem === null ? null : (
          <p id={problemId} role="alert" className="field-error">
            {problem.text}
          </p>
        )}
        {/* Always in the page, so a new notice is announced. */}
        <p role="status">{notice}</p>
        {/* aria-disabled, not disabled: the keyboard stays on it while the visit saves. */}
        <button ref={recordButton} type="button" className="primary record" aria-disabled={saving} onClick={record}>
          {saving ? "Saving…" : "Record visit"}
        </button>
      </div>
    </section>
  );
}

interface RewardMessage {
  text: string;
  problem: boolean;
}

/** A redemption sent without a confirmed answer yet; `earlier` when it was found on the phone after a reload. */
type PendingReward = StoredRedemption & { earlier: boolean };

const clock = new Intl.DateTimeFormat("en-GB", { timeStyle: "short" });
const startedAt = (attempt: StoredRedemption) => clock.format(new Date(attempt.startedAt));

interface RedeemPanelProps {
  device: DeviceRecord;
  barista: StaffEntry;
  catalog: DeviceCatalog;
  online: boolean;
  scanner: ScanPurpose | null;
  onScanner: (purpose: ScanPurpose | null) => void;
  onBusy: (busy: boolean) => void;
}

/**
 * Gives a reward for a scanned card, online only (AC 31). A redemption without a confirmed answer is kept in
 * IndexedDB and must be tried again (same event id) before another can start, so a lost answer, a reload or an update
 * never gives the reward twice.
 */
function RedeemPanel({ device, barista, catalog, online, scanner, onScanner, onBusy }: RedeemPanelProps) {
  const [pending, setPending] = useState<PendingReward | null>(null);
  const [message, setMessage] = useState<RewardMessage | null>(null);
  const [sending, setSending] = useState(false);
  /** Bumped whenever the scanner closes or an attempt ends: the keyboard goes back to the panel's button. */
  const [refocus, setRefocus] = useState(0);
  /** "Scan card for a reward" or "Try again", whichever is shown. */
  const actionButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (refocus > 0) {
      actionButton.current?.focus();
    }
  }, [refocus]);

  useEffect(() => {
    let current = true;
    getMeta("pendingRedemption").then(
      (stored) => {
        if (current && stored !== undefined) {
          setPending({ ...stored, earlier: true });
          setMessage({
            text: `A reward started at ${startedAt(stored)} was not confirmed. Press Try again to find out whether that customer got it, before giving another.`,
            problem: true,
          });
        }
      },
      (caught: unknown) => {
        console.error("Reading the unconfirmed reward failed", caught);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    onBusy(pending !== null || sending || scanner === "reward");
  }, [pending, sending, scanner, onBusy]);

  /** Ends an attempt: the message, and the keyboard back on the panel's button. */
  const finish = (text: string, problem: boolean) => {
    setSending(false);
    setMessage({ text, problem });
    setRefocus((turn) => turn + 1);
  };

  /** The server's answer, so the redemption is done with either way. */
  const settle = (text: string, problem: boolean) => {
    setPending(null);
    finish(text, problem);
    deleteMeta("pendingRedemption").catch((caught: unknown) => {
      console.error("Clearing the unconfirmed reward failed", caught);
    });
  };

  const send = async (attempt: PendingReward) => {
    setSending(true);
    setMessage(null);
    try {
      // Kept before it is sent: if the answer is lost, the same redemption is tried again.
      await setMeta("pendingRedemption", { eventId: attempt.eventId, cardQr: attempt.cardQr, startedAt: attempt.startedAt });
    } catch (caught) {
      console.error("Keeping the reward failed", caught);
      finish("The reward could not be started on this phone. Reload the page and try again.", true);
      return;
    }
    setPending(attempt);
    // One from before a reload may be for a customer who has left: the barista is told which one it was.
    const earlier = attempt.earlier ? `The earlier reward, started at ${startedAt(attempt)},` : null;
    try {
      const redemption = await deviceRequest("POST", "/api/device/redemptions", redemptionSchema, { eventId: attempt.eventId, staffId: barista.id, cardQr: attempt.cardQr });
      const left = plural(redemption.stampsLeft, "stamp", "stamps");
      settle(
        earlier === null
          ? `Reward given: ${redemption.rewardNameEn}. ${left} left on the card.`
          : `${earlier} was given: ${redemption.rewardNameEn}. ${left} left on that card. If that customer did not get it, tell the owner.`,
        false,
      );
    } catch (caught) {
      if (caught instanceof RequestError && caught.failure.retryable) {
        // Nothing sends it again by itself, and whether it was given is unknown until it is.
        finish(`The reward started at ${startedAt(attempt)} was not confirmed. Do not give it yet: check the connection, then press Try again.`, true);
      } else if (caught instanceof RequestError || caught instanceof DeviceUnpairedError) {
        settle(earlier === null ? caught.message : `${earlier} was not given: ${caught.message}`, true);
      } else {
        console.error("Redeeming failed", caught);
        finish("The reward could not be confirmed on this phone. Reload the page, then press Try again.", true);
      }
    }
  };

  if (catalog.program === null) {
    return null;
  }
  return (
    <section aria-labelledby="redeem-title" className="card">
      <h3 id="redeem-title">Give a reward</h3>
      <p className="hint">
        {catalog.program.rewardNameEn} for {plural(catalog.program.stampsRequired, "stamp", "stamps")}.
      </p>
      {scanner === "reward" ? (
        <QrScanner
          purpose="customer's loyalty card QR code"
          noCamera="Rewards need the card scanned: give them from a phone with a camera."
          onCancel={() => {
            onScanner(null);
            setRefocus((turn) => turn + 1);
          }}
          onScan={(text) => {
            onScanner(null);
            const read = readCardQr(text, device.cafe.id);
            if ("problem" in read) {
              finish(read.problem, true);
            } else {
              void send({ eventId: crypto.randomUUID(), cardQr: read.token, startedAt: new Date().toISOString(), earlier: false });
            }
          }}
        />
      ) : (
        <>
          {/* Always in the page, so going offline is announced. */}
          <p role="status" className={online ? undefined : "field-error"}>
            {online ? "" : "Rewards need an internet connection. Connect the phone, then try again."}
          </p>
          {pending === null ? (
            <button
              ref={actionButton}
              type="button"
              disabled={!online || sending || scanner !== null}
              onClick={() => {
                setMessage(null);
                onScanner("reward");
              }}
            >
              Scan card for a reward
            </button>
          ) : (
            <button
              ref={actionButton}
              type="button"
              disabled={!online || sending}
              onClick={() => {
                void send(pending);
              }}
            >
              {sending ? "Sending…" : "Try again"}
            </button>
          )}
        </>
      )}
      {message?.problem === true ? (
        <p role="alert" className="field-error">
          {message.text}
        </p>
      ) : null}
      {/* Always in the page, so the confirmation is announced. */}
      <p role="status">{message?.problem === false ? message.text : ""}</p>
    </section>
  );
}

/** The barista's counter: recording visits, and rewards when online. The camera serves one of them at a time. */
export function CounterScreen({
  device,
  barista,
  catalog,
  online,
  onBusy,
}: {
  device: DeviceRecord;
  barista: StaffEntry;
  catalog: DeviceCatalog | undefined;
  online: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [scanner, setScanner] = useState<ScanPurpose | null>(null);
  const [visitBusy, setVisitBusy] = useState(false);
  const [rewardBusy, setRewardBusy] = useState(false);
  useEffect(() => {
    onBusy(visitBusy || rewardBusy);
  }, [visitBusy, rewardBusy, onBusy]);
  // Whatever screen comes next is not busy because of this one.
  useEffect(
    () => () => {
      onBusy(false);
    },
    [onBusy],
  );

  if (catalog === undefined) {
    return <p className="empty">{online ? "Loading the menu…" : "Connect to the internet once to load the menu."}</p>;
  }
  if (catalog.orderTypes.length === 0) {
    return <p className="empty">Nothing is on sale yet. Ask the owner to add order types on the dashboard.</p>;
  }
  // Both stay mounted (an open order survives a reward); the other's scan button is disabled while one scans.
  return (
    <div className="counter-screen">
      <VisitForm device={device} barista={barista} catalog={catalog} scanner={scanner} onScanner={setScanner} onBusy={setVisitBusy} />
      <RedeemPanel device={device} barista={barista} catalog={catalog} online={online} scanner={scanner} onScanner={setScanner} onBusy={setRewardBusy} />
    </div>
  );
}
