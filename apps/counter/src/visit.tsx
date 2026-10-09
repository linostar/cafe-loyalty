import { formatUsd, normalizePhoneInput, parseCardQr, redemptionSchema, visitItemsTotalCents, visitRecordedV1PayloadSchema, type DeviceCatalog } from "@cafe-loyalty/shared";
import { useEffect, useId, useState } from "react";
import { DeviceUnpairedError, RequestError, deviceRequest } from "./device.js";
import { QrScanner } from "./scanner.js";
import type { DeviceRecord, StaffEntry } from "./storage.js";
import { recordEvent } from "./sync.js";

type CardChoice = { kind: "qr"; token: string } | { kind: "phone"; phone: string };

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

/** Records a visit offline: what was ordered and whose card, by QR or phone number (AC 22, 30, 32). */
function VisitForm({ device, barista, catalog, onBusy }: { device: DeviceRecord; barista: StaffEntry; catalog: DeviceCatalog; onBusy: (busy: boolean) => void }) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [scanned, setScanned] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const phoneId = useId();

  const items = catalog.orderTypes
    .filter((type) => (quantities[type.id] ?? 0) > 0)
    .map((type) => ({ type, quantity: quantities[type.id] ?? 0 }));
  const stamps = items.reduce((sum, item) => sum + item.quantity * item.type.stampsEarned, 0);
  const total = visitItemsTotalCents(items.map(({ type, quantity }) => ({ orderTypeId: type.id, quantity, unitPriceCents: type.priceCents, unitCostCents: type.costCents, catalogVersion: catalog.catalogVersion })));
  // An order in progress: the app must not update under it (AC 29).
  const open = items.length > 0 || scanned !== null || phone !== "" || scanning;
  useEffect(() => {
    onBusy(open || saving);
  }, [open, saving, onBusy]);
  useEffect(
    () => () => {
      onBusy(false);
    },
    [onBusy],
  );

  const change = (id: string, delta: number) => {
    setNotice(null);
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
    const payload = visitRecordedV1PayloadSchema.safeParse({
      card,
      items: items.map(({ type, quantity }) => ({ orderTypeId: type.id, quantity, unitPriceCents: type.priceCents, unitCostCents: type.costCents, catalogVersion: catalog.catalogVersion })),
      totalCents: total ?? -1,
    });
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
        setNotice(`Visit saved${stamps > 0 ? `: ${String(stamps)} ${stamps === 1 ? "stamp" : "stamps"} for this card` : ""}. It is sent as soon as the phone is online.`);
      },
      (caught: unknown) => {
        console.error("Recording the visit failed", caught);
        setSaving(false);
        setProblem("The visit could not be saved on this phone. Reload the page and record it again.");
      },
    );
  };

  if (scanning) {
    return (
      <section aria-labelledby="scan-title">
        <h3 id="scan-title">Scan the customer&apos;s card</h3>
        <QrScanner
          purpose="customer's loyalty card QR code"
          onCancel={() => {
            setScanning(false);
          }}
          onScan={(text) => {
            setScanning(false);
            const read = readCardQr(text, device.cafe.id);
            if ("problem" in read) {
              setProblem(read.problem);
            } else {
              setScanned(read.token);
              setPhone("");
              setProblem(null);
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
                {type.stampsEarned > 0 ? ` · ${String(type.stampsEarned)} ${type.stampsEarned === 1 ? "stamp" : "stamps"}` : ""}
              </span>
              <span className="stepper">
                <button type="button" aria-label={`One less ${type.nameEn}`} disabled={quantity === 0} onClick={() => { change(type.id, -1); }}>
                  −
                </button>
                <span className="count">{quantity}</span>
                <button type="button" aria-label={`One more ${type.nameEn}`} disabled={quantity === 50} onClick={() => { change(type.id, 1); }}>
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <p>
        Total {formatUsd(total ?? 0, "en")} · {stamps} {stamps === 1 ? "stamp" : "stamps"}
      </p>
      <div className="card-choice">
        {scanned === null ? (
          <button
            type="button"
            onClick={() => {
              setScanning(true);
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
                setNotice(null);
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
      {notice === null ? null : <p role="status">{notice}</p>}
      <button type="button" disabled={saving} onClick={record}>
        {saving ? "Saving…" : "Record visit"}
      </button>
    </section>
  );
}

/** Gives a reward for a scanned card, online only (AC 31); a retry after a lost answer reuses the same event id. */
function RedeemPanel({ device, barista, catalog, online }: { device: DeviceRecord; barista: StaffEntry; catalog: DeviceCatalog; online: boolean }) {
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<{ eventId: string; cardQr: string } | null>(null);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  const [sending, setSending] = useState(false);

  const send = (attempt: { eventId: string; cardQr: string }) => {
    setSending(true);
    setMessage(null);
    deviceRequest("POST", "/api/device/redemptions", redemptionSchema, { eventId: attempt.eventId, staffId: barista.id, cardQr: attempt.cardQr }).then(
      (redemption) => {
        setSending(false);
        setPending(null);
        setMessage({ text: `Reward given: ${redemption.rewardNameEn}. ${String(redemption.stampsLeft)} ${redemption.stampsLeft === 1 ? "stamp" : "stamps"} left on the card.`, problem: false });
      },
      (caught: unknown) => {
        setSending(false);
        if (caught instanceof RequestError && caught.failure.retryable) {
          // Kept, so trying again cannot give the reward twice.
          setPending(attempt);
          setMessage({ text: `The reward was not confirmed: ${caught.message} Try again.`, problem: true });
        } else if (caught instanceof RequestError || caught instanceof DeviceUnpairedError) {
          setPending(null);
          setMessage({ text: caught.message, problem: true });
        } else {
          console.error("Redeeming failed", caught);
          setPending(null);
          setMessage({ text: "The reward could not be given on this phone. Reload the page and try again.", problem: true });
        }
      },
    );
  };

  if (catalog.program === null) {
    return null;
  }
  const reward = catalog.program.rewardNameEn;
  return (
    <section aria-labelledby="redeem-title">
      <h3 id="redeem-title">Give a reward</h3>
      <p>
        {reward} for {catalog.program.stampsRequired} stamps.
      </p>
      {scanning ? (
        <QrScanner
          purpose="customer's loyalty card QR code"
          onCancel={() => {
            setScanning(false);
          }}
          onScan={(text) => {
            setScanning(false);
            const read = readCardQr(text, device.cafe.id);
            if ("problem" in read) {
              setMessage({ text: read.problem, problem: true });
            } else {
              send({ eventId: crypto.randomUUID(), cardQr: read.token });
            }
          }}
        />
      ) : (
        <>
          {online ? null : <p className="warning">Rewards need an internet connection. Connect the phone, then try again.</p>}
          {pending === null ? (
            <button
              type="button"
              disabled={!online || sending}
              onClick={() => {
                setMessage(null);
                setScanning(true);
              }}
            >
              Scan card for a reward
            </button>
          ) : (
            <button
              type="button"
              disabled={!online || sending}
              onClick={() => {
                send(pending);
              }}
            >
              {sending ? "Sending…" : "Try again"}
            </button>
          )}
        </>
      )}
      {message === null ? null : message.problem ? (
        <p role="alert" className="field-error">
          {message.text}
        </p>
      ) : (
        <p role="status">{message.text}</p>
      )}
    </section>
  );
}

/** The barista's counter: recording visits, and rewards when online. */
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
  if (catalog === undefined) {
    return <p>{online ? "Loading the menu…" : "Connect to the internet once to load the menu."}</p>;
  }
  if (catalog.orderTypes.length === 0) {
    return <p>Nothing is on sale yet. Ask the owner to add order types on the dashboard.</p>;
  }
  return (
    <>
      <VisitForm device={device} barista={barista} catalog={catalog} onBusy={onBusy} />
      <RedeemPanel device={device} barista={barista} catalog={catalog} online={online} />
    </>
  );
}
