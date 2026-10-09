import { formatUsd, normalizePhoneInput, parseCardQr, redemptionSchema, visitItemsTotalCents, visitRecordedV1PayloadSchema, type DeviceCatalog } from "@cafe-loyalty/shared";
import { useEffect, useId, useRef, useState } from "react";
import { DeviceUnpairedError, RequestError, deviceRequest } from "./device.js";
import { QrScanner } from "./scanner.js";
import { deleteMeta, getMeta, setMeta, type DeviceRecord, type StaffEntry } from "./storage.js";
import { recordEvent } from "./sync.js";

type CardChoice = { kind: "qr"; token: string } | { kind: "phone"; phone: string };
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
  const [scanned, setScanned] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const phoneId = useId();
  const scanButton = useRef<HTMLButtonElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);

  const items = catalog.orderTypes.filter((type) => (quantities[type.id] ?? 0) > 0).map((type) => ({ type, quantity: quantities[type.id] ?? 0 }));
  // Taken off sale by the owner while this order was open: left out, and said so.
  const dropped = Object.entries(quantities).some(([id, quantity]) => quantity > 0 && !catalog.orderTypes.some((type) => type.id === id));
  const stamps = items.reduce((sum, item) => sum + item.quantity * item.type.stampsEarned, 0);
  const lines = items.map(({ type, quantity }) => ({
    orderTypeId: type.id,
    quantity,
    unitPriceCents: type.priceCents,
    unitCostCents: type.costCents,
    catalogVersion: catalog.catalogVersion,
  }));
  const total = visitItemsTotalCents(lines);
  // An order in progress: the app must not update under it (AC 29).
  const open = items.length > 0 || scanned !== null || phone !== "" || scanner === "visit";
  useEffect(() => {
    onBusy(open || saving);
  }, [open, saving, onBusy]);

  const change = (id: string, delta: number) => {
    setNotice("");
    setQuantities((current) => ({ ...current, [id]: Math.max(0, Math.min(50, (current[id] ?? 0) + delta)) }));
  };

  const record = () => {
    setProblem(null);
    let card: CardChoice;
    if (scanned !== null) {
      card = { kind: "qr", token: scanned };
    } else {
      const e164 = normalizePhoneInput(phone);
      if (e164 === null) {
        setProblem(phone === "" ? "Scan the customer's card, or enter their mobile number." : "Enter a Lebanese mobile number, such as 70 123 456.");
        return;
      }
      card = { kind: "phone", phone: e164 };
    }
    const payload = visitRecordedV1PayloadSchema.safeParse({ card, items: lines, totalCents: total ?? -1 });
    if (!payload.success) {
      setProblem(items.length === 0 ? "Add what the customer ordered first." : "This order is too large to record. Split it into two visits.");
      return;
    }
    setSaving(true);
    recordEvent("visit.recorded", 1, barista.id, payload.data).then(
      () => {
        setSaving(false);
        setQuantities({});
        setScanned(null);
        setPhone("");
        // The server decides the stamps (cooldown, daily cap), so the counter promises no more than the order earns.
        setNotice(`Visit saved${stamps > 0 ? `, earning up to ${plural(stamps, "stamp", "stamps")}` : ""}. It is sent as soon as the phone is online.`);
      },
      (caught: unknown) => {
        console.error("Recording the visit failed", caught);
        setSaving(false);
        setProblem("The visit could not be saved on this phone. Reload the page and record it again.");
      },
    );
  };

  if (scanner === "visit") {
    return (
      <section aria-labelledby="scan-title">
        <h3 id="scan-title">Scan the customer&apos;s card</h3>
        <QrScanner
          purpose="customer's loyalty card QR code"
          onCancel={() => {
            onScanner(null);
            requestAnimationFrame(() => scanButton.current?.focus());
          }}
          onScan={(text) => {
            onScanner(null);
            const read = readCardQr(text, device.cafe.id);
            if ("problem" in read) {
              setProblem(read.problem);
              requestAnimationFrame(() => scanButton.current?.focus());
            } else {
              setScanned(read.token);
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
    <section aria-labelledby="visit-title">
      <h3 id="visit-title">New visit</h3>
      <ul className="menu">
        {catalog.orderTypes.map((type) => {
          const quantity = quantities[type.id] ?? 0;
          return (
            <li key={type.id}>
              <span>
                <strong>{type.nameEn}</strong> · {formatUsd(type.priceCents, "en")}
                {type.stampsEarned > 0 ? ` · ${plural(type.stampsEarned, "stamp", "stamps")}` : ""}
              </span>
              <span className="stepper">
                <button
                  type="button"
                  aria-label={`One less ${type.nameEn}`}
                  disabled={quantity === 0}
                  onClick={() => {
                    change(type.id, -1);
                  }}
                >
                  −
                </button>
                <span className="count">{quantity}</span>
                <button
                  type="button"
                  aria-label={`One more ${type.nameEn}`}
                  disabled={quantity === 50}
                  onClick={() => {
                    change(type.id, 1);
                  }}
                >
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {dropped ? <p className="warning">Something in this order is no longer on sale and was left out. Check the order.</p> : null}
      <p aria-live="polite">
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
              onChange={(event) => {
                setPhone(event.target.value);
                setNotice("");
              }}
            />
          </div>
        ) : null}
      </div>
      {problem === null ? null : (
        <p role="alert" className="field-error">
          {problem}
        </p>
      )}
      {/* Always in the page, so a new notice is announced. */}
      <p role="status">{notice}</p>
      <button ref={recordButton} type="button" disabled={saving} onClick={record}>
        {saving ? "Saving…" : "Record visit"}
      </button>
    </section>
  );
}

interface RewardMessage {
  text: string;
  problem: boolean;
}

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
  const [pending, setPending] = useState<{ eventId: string; cardQr: string } | null>(null);
  const [message, setMessage] = useState<RewardMessage | null>(null);
  const [sending, setSending] = useState(false);
  const scanButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    getMeta("pendingRedemption").then(
      (stored) => {
        if (current && stored !== undefined) {
          setPending(stored);
          setMessage({ text: "A reward was not confirmed before. Try it again before giving another.", problem: true });
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

  const settle = (text: string, problem: boolean) => {
    setSending(false);
    setPending(null);
    setMessage({ text, problem });
    deleteMeta("pendingRedemption").catch((caught: unknown) => {
      console.error("Clearing the unconfirmed reward failed", caught);
    });
  };

  const send = async (attempt: { eventId: string; cardQr: string }) => {
    setSending(true);
    setMessage(null);
    try {
      // Kept before it is sent: if the answer is lost, the same redemption is tried again.
      await setMeta("pendingRedemption", attempt);
    } catch (caught) {
      console.error("Keeping the reward failed", caught);
      setSending(false);
      setMessage({ text: "The reward could not be started on this phone. Reload the page and try again.", problem: true });
      return;
    }
    setPending(attempt);
    try {
      const redemption = await deviceRequest("POST", "/api/device/redemptions", redemptionSchema, { eventId: attempt.eventId, staffId: barista.id, cardQr: attempt.cardQr });
      settle(`Reward given: ${redemption.rewardNameEn}. ${plural(redemption.stampsLeft, "stamp", "stamps")} left on the card.`, false);
    } catch (caught) {
      if (caught instanceof RequestError && caught.failure.retryable) {
        setSending(false);
        setMessage({ text: `The reward was not confirmed: ${caught.message} Try again.`, problem: true });
      } else if (caught instanceof RequestError || caught instanceof DeviceUnpairedError) {
        settle(caught.message, true);
      } else {
        console.error("Redeeming failed", caught);
        setSending(false);
        setMessage({ text: "The reward could not be confirmed on this phone. Try again.", problem: true });
      }
    }
  };

  if (catalog.program === null) {
    return null;
  }
  return (
    <section aria-labelledby="redeem-title">
      <h3 id="redeem-title">Give a reward</h3>
      <p>
        {catalog.program.rewardNameEn} for {plural(catalog.program.stampsRequired, "stamp", "stamps")}.
      </p>
      {scanner === "reward" ? (
        <QrScanner
          purpose="customer's loyalty card QR code"
          onCancel={() => {
            onScanner(null);
            requestAnimationFrame(() => scanButton.current?.focus());
          }}
          onScan={(text) => {
            onScanner(null);
            const read = readCardQr(text, device.cafe.id);
            requestAnimationFrame(() => scanButton.current?.focus());
            if ("problem" in read) {
              setMessage({ text: read.problem, problem: true });
            } else {
              void send({ eventId: crypto.randomUUID(), cardQr: read.token });
            }
          }}
        />
      ) : (
        <>
          {online ? null : <p className="warning">Rewards need an internet connection. Connect the phone, then try again.</p>}
          {pending === null ? (
            <button
              ref={scanButton}
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
    return <p>{online ? "Loading the menu…" : "Connect to the internet once to load the menu."}</p>;
  }
  if (catalog.orderTypes.length === 0) {
    return <p>Nothing is on sale yet. Ask the owner to add order types on the dashboard.</p>;
  }
  // Both stay mounted (an open order survives a reward); the other's scan button is disabled while one scans.
  return (
    <>
      <VisitForm device={device} barista={barista} catalog={catalog} scanner={scanner} onScanner={setScanner} onBusy={setVisitBusy} />
      <RedeemPanel device={device} barista={barista} catalog={catalog} online={online} scanner={scanner} onScanner={setScanner} onBusy={setRewardBusy} />
    </>
  );
}
