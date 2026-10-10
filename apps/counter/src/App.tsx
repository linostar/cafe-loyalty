import { deviceCatalogSchema, deviceStaffSchema, normalizePairingCode, type DeviceCatalog } from "@cafe-loyalty/shared";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DeviceUnpairedError, PairedElsewhereError, RequestError, deviceRequestFor, pairDevice } from "./device.js";
import { attemptPin } from "./pin.js";
import {
  clearRejected,
  countQueued,
  deleteMeta,
  getLockout,
  getMeta,
  listRejected,
  onStorageChange,
  setMeta,
  storeCatalog,
  storeStaff,
  type DeviceRecord,
  type RejectedEvent,
  type StaffEntry,
} from "./storage.js";
import { syncQueue } from "./sync.js";
import { useServiceWorkerUpdate, type UpdateState } from "./updates.js";
import { useOnlineStatus } from "./useOnlineStatus.js";
import { CounterScreen } from "./visit.js";

/** How often a counter with waiting events tries to send them. */
const SYNC_INTERVAL_MS = 30_000;
/** How often a counter reloads its baristas, so a removed one can no longer sign in. */
const STAFF_REFRESH_MS = 5 * 60 * 1000;

const clock = new Intl.DateTimeFormat("en-GB", { timeStyle: "short" });
const dateTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

interface Stored {
  device: DeviceRecord | undefined;
  staff: StaffEntry[];
  baristaId: string | undefined;
  pending: number;
  rejected: RejectedEvent[];
  catalog: DeviceCatalog | undefined;
}

async function readStored(): Promise<Stored> {
  const [device, staff, barista, pending, rejected, catalog] = await Promise.all([
    getMeta("device"),
    getMeta("staff"),
    getMeta("barista"),
    countQueued(),
    listRejected(),
    getMeta("catalog"),
  ]);
  // A catalog an older build stored has no campaigns (nor their time zone) or win-back offers: none apply until the next
  // refresh.
  return {
    device,
    staff: staff ?? [],
    baristaId: barista?.staffId,
    pending,
    rejected,
    catalog: catalog && { ...catalog, timeZone: catalog.timeZone ?? "UTC", campaigns: catalog.campaigns ?? [], winBackOffers: catalog.winBackOffers ?? [] },
  };
}

const EVENT_LABELS: Readonly<Record<string, string>> = { "visit.recorded": "Visit", "staff.pin_lockout": "PIN lockout report" };

const REJECTION_REASONS: Readonly<Record<string, string>> = {
  CARD_NOT_FOUND: "the card is not a card of this café; scan the customer's card again next time",
  CARD_REPLACED: "the card was moved to another phone; ask the customer to show the card on their new phone",
  PHONE_NOT_CONFIRMED: "this number is not confirmed yet; scan the customer's card once, then their number works too",
  PHONE_DISPUTED: "another card at this café signed up with this number, so it cannot be stamped by number; scan the customer's card",
  UNKNOWN_ORDER_TYPE: "something ordered is no longer on the café's menu",
  CAMPAIGN_REFUSED: "its discount named a campaign this café does not have; record the visit again",
  INVALID_EVENT: "the server could not accept it as recorded",
  SIGNATURE_INVALID: "this phone's signature did not check out",
  CLOCK_SKEW: "the phone's clock was wrong; set its date and time to automatic",
  IDEMPOTENCY_CONFLICT: "it clashed with something this phone sent before",
};

interface StatusBarProps {
  online: boolean;
  pending: number;
  problem: string | null;
  notice: string | null;
  update: UpdateState;
}

/** Always visible: connectivity, what waits to be sent, problems and the build (AC 29). */
function StatusBar({ online, pending, problem, notice, update }: StatusBarProps) {
  return (
    <section aria-label="Counter status" className="status-bar">
      <p role="status" aria-live="polite">
        {online ? "Online" : "Offline: stamps are saved on this phone and sync when the connection returns."}
      </p>
      {/* Not live: it changes with every sync, and the count is there to look at, not to hear. */}
      <p>{pending === 0 ? "Nothing waiting to send." : `${String(pending)} waiting to send.`}</p>
      {/* Always in the page, so screen readers announce what appears in it. */}
      <div aria-live="polite">
        {problem === null ? null : <p className="warning">{problem}</p>}
        {notice === null ? null : <p className="warning">{notice}</p>}
        {update.waiting ? <p>An update is ready. It installs once everything is sent and nobody is typing.</p> : null}
        {update.error === null ? null : <p className="warning">{update.error}</p>}
      </div>
      <p className="build">Build {__BUILD_ID__}</p>
    </section>
  );
}

/** Events the server refused for good, kept on screen until cleared (AC 23). */
function RejectedList({ rejected }: { rejected: RejectedEvent[] }) {
  const [error, setError] = useState<string | null>(null);
  if (rejected.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="rejected-title" className="rejected">
      <h2 id="rejected-title">Not accepted by the server</h2>
      <p>These were not recorded. Show this list to the owner.</p>
      <ul>
        {rejected.map((entry) => (
          <li key={entry.eventId}>
            {EVENT_LABELS[entry.type] ?? entry.type} from {dateTime.format(new Date(entry.occurredAt))}: {REJECTION_REASONS[entry.code] ?? `refused (${entry.code})`}.
          </li>
        ))}
      </ul>
      {error === null ? null : <p role="alert">{error}</p>}
      <button
        type="button"
        onClick={() => {
          clearRejected().catch((caught: unknown) => {
            console.error("Clearing the error list failed", caught);
            setError("The list could not be cleared. Reload the page and try again.");
          });
        }}
      >
        Clear list
      </button>
    </section>
  );
}

/** The pairing code from the page's address (`/pair#code=…`, the dashboard's QR), read once and then removed. */
function useFragmentCode(): string {
  const [code] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("code") ?? "");
  useEffect(() => {
    if (window.location.hash !== "") {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  return code;
}

interface PairScreenProps {
  device: DeviceRecord | undefined;
  /** Events waiting to be sent, which starting over (pairing with another café) would discard. */
  waiting: number;
  onPaired: () => void;
  onBusy: (busy: boolean) => void;
}

function PairScreen({ device, waiting, onPaired, onBusy }: PairScreenProps) {
  const fromLink = useFragmentCode();
  const [code, setCode] = useState(fromLink);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the code is for another café than the phone's: starting over needs a confirmation if it loses events. */
  const [elsewhere, setElsewhere] = useState<{ code: string; cafeName: string } | null>(null);

  const pair = (normalized: string, startOver: boolean) => {
    setPending(true);
    setError(null);
    pairDevice(normalized, { startOver }).then(
      () => {
        setPending(false);
        setElsewhere(null);
        setCode("");
        onPaired();
      },
      (caught: unknown) => {
        setPending(false);
        if (caught instanceof PairedElsewhereError && waiting === 0) {
          // Nothing waits to be sent, so nothing is lost by starting over.
          pair(normalized, true);
        } else if (caught instanceof PairedElsewhereError) {
          setElsewhere({ code: normalized, cafeName: caught.cafeName });
        } else if (caught instanceof RequestError || caught instanceof DeviceUnpairedError) {
          setError(caught.message);
        } else {
          console.error("Pairing failed", caught);
          setError("Pairing failed on this phone. Reload the page and try again.");
        }
      },
    );
  };
  const inputId = useId();
  const errorId = `${inputId}-error`;

  useEffect(() => {
    onBusy(pending || code !== "");
  }, [pending, code, onBusy]);
  // Whatever screen comes next is not busy because of this one.
  useEffect(
    () => () => {
      onBusy(false);
    },
    [onBusy],
  );

  let intro: ReactNode = null;
  if (device?.unpairedReason === "revoked") {
    intro = <p className="warning">The owner removed this phone. Ask them for a new pairing code to use it again. Its waiting stamps are kept and sent once it is paired.</p>;
  } else if (device?.unpairedReason === "pairing_required") {
    intro = <p className="warning">This phone was offline too long and must be paired again. Its waiting stamps are kept and sent once it is paired.</p>;
  } else if (device?.paired === true) {
    intro = (
      <p>
        This phone is paired as {device.deviceName} at {device.cafe.name}. Pairing it again replaces that.
      </p>
    );
  }

  return (
    <section aria-labelledby="pair-title">
      <h2 id="pair-title" tabIndex={-1}>
        Pair this phone
      </h2>
      {intro}
      <p>On the owner&apos;s dashboard, open Devices and create a pairing code. Scan its QR code with this phone&apos;s camera, or type the code here.</p>
      {elsewhere === null ? null : (
        <div role="alert" className="warning-box">
          <p>
            This phone is still paired with {elsewhere.cafeName} and has {String(waiting)} {waiting === 1 ? "item" : "items"} waiting to send there. Pair it with{" "}
            {elsewhere.cafeName} first to send {waiting === 1 ? "it" : "them"}. Starting over here discards {waiting === 1 ? "it" : "them"} for good.
          </p>
          <div className="actions">
            <button
              type="button"
              className="danger"
              disabled={pending}
              onClick={() => {
                pair(elsewhere.code, true);
              }}
            >
              Start over and discard {waiting === 1 ? "it" : "them"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setElsewhere(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = normalizePairingCode(code);
          if (normalized === null) {
            setError("Enter the 12-character code shown on the owner's dashboard.");
            return;
          }
          pair(normalized, false);
        }}
      >
        <label htmlFor={inputId}>Pairing code</label>
        <input
          id={inputId}
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          required
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
        />
        {error === null ? null : (
          <p id={errorId} role="alert" className="field-error">
            {error}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? "Pairing…" : "Pair this phone"}
        </button>
      </form>
    </section>
  );
}

function PinScreen({ staff, onSignedIn, onBack, onBusy }: { staff: StaffEntry; onSignedIn: () => void; onBack: () => void; onBusy: (busy: boolean) => void }) {
  const [pin, setPin] = useState("");
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const inputId = useId();
  const messageId = `${inputId}-message`;

  useEffect(() => {
    onBusy(checking || pin !== "");
  }, [checking, pin, onBusy]);
  useEffect(
    () => () => {
      onBusy(false);
    },
    [onBusy],
  );

  useEffect(() => {
    let current = true;
    getLockout(staff.id).then(
      (lockout) => {
        if (current && lockout?.lockedUntil != null && lockout.lockedUntil > Date.now()) {
          setLockedUntil(lockout.lockedUntil);
        }
      },
      (caught: unknown) => {
        console.error("Reading the PIN lockout failed", caught);
        if (current) {
          setMessage("This phone's storage could not be read. Reload the page and try again.");
        }
      },
    );
    return () => {
      current = false;
    };
  }, [staff.id]);

  // Lifts the lockout on screen when it ends.
  useEffect(() => {
    if (lockedUntil === null) {
      return;
    }
    const timer = setTimeout(
      () => {
        setLockedUntil(null);
      },
      Math.max(lockedUntil - Date.now(), 0),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [lockedUntil]);

  const locked = lockedUntil !== null;
  const shown = locked ? `Too many wrong PINs. ${staff.name} can try again at ${clock.format(new Date(lockedUntil))}.` : message;

  // The PIN field is disabled while locked out: keep focus on the screen, and back in the field when it ends.
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const wasLocked = useRef(false);
  useEffect(() => {
    if (locked) {
      heading.current?.focus();
    } else if (wasLocked.current) {
      input.current?.focus();
    }
    wasLocked.current = locked;
  }, [locked]);

  return (
    <section aria-labelledby="pin-title">
      <h2 id="pin-title" tabIndex={-1} ref={heading}>
        PIN for {staff.name}
      </h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!/^\d{6,12}$/.test(pin)) {
            setMessage("Enter the 6 to 12 digit PIN the owner set for you.");
            return;
          }
          setChecking(true);
          setMessage(null);
          attemptPin(staff, pin).then(
            (attempt) => {
              setChecking(false);
              setPin("");
              if (attempt.status === "accepted") {
                onSignedIn();
              } else if (attempt.status === "locked") {
                setLockedUntil(attempt.lockedUntil);
              } else {
                setMessage(`Wrong PIN. ${String(attempt.attemptsLeft)} ${attempt.attemptsLeft === 1 ? "try" : "tries"} left before a pause.`);
              }
            },
            (caught: unknown) => {
              console.error("Checking the PIN failed", caught);
              setChecking(false);
              setMessage("The PIN could not be checked on this phone. Reload the page and try again.");
            },
          );
        }}
      >
        <label htmlFor={inputId}>PIN</label>
        <input
          ref={input}
          id={inputId}
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          required
          disabled={locked}
          value={pin}
          onChange={(event) => {
            setPin(event.target.value);
          }}
          aria-invalid={message === null || locked ? undefined : true}
          aria-describedby={shown === null ? undefined : messageId}
        />
        {shown === null ? null : (
          <p id={messageId} role="alert" className="field-error">
            {shown}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={checking || locked}>
            {checking ? "Checking…" : "Sign in"}
          </button>
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </form>
    </section>
  );
}

function BaristaPicker({ staff, online, onChoose }: { staff: StaffEntry[]; online: boolean; onChoose: (staff: StaffEntry) => void }) {
  return (
    <section aria-labelledby="who-title">
      <h2 id="who-title" tabIndex={-1}>
        Who is working?
      </h2>
      {staff.length === 0 ? (
        <p>{online ? "No baristas yet. Ask the owner to add staff on the dashboard." : "Connect to the internet once to load the baristas."}</p>
      ) : (
        <ul className="choices">
          {staff.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => {
                  onChoose(member);
                }}
              >
                {member.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Screen = "loading" | "pair" | "who" | "pin" | "home";

export function App() {
  const online = useOnlineStatus();
  const [stored, setStored] = useState<Stored | null>(null);
  const [path, setPath] = useState(window.location.pathname);
  /** The barista picked to enter a PIN, by id: their entry is always the latest one stored (PIN changed, removed). */
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const update = useServiceWorkerUpdate(stored?.pending === 0 && !busy);
  const screenRef = useRef<HTMLDivElement>(null);
  const shownScreen = useRef<Screen | null>(null);

  const reload = useCallback(() => {
    readStored().then(setStored, (caught: unknown) => {
      console.error("Reading this phone's storage failed", caught);
      setProblem("This phone's storage could not be read. Reload the page; if it keeps failing, check that the browser allows site data.");
    });
  }, []);

  useEffect(() => {
    reload();
    return onStorageChange(reload);
  }, [reload]);

  /** Runs server work and shows what went wrong, never failing silently (AC 28, 42). Queued events are kept. */
  const handled = useCallback(async (work: () => Promise<unknown>) => {
    try {
      await work();
      setProblem(null);
    } catch (caught) {
      if (caught instanceof DeviceUnpairedError) {
        // The pairing screen explains it.
        setProblem(null);
      } else if (caught instanceof RequestError && caught.failure.code === "CLIENT_TOO_OLD") {
        setNotice(caught.message);
      } else if (caught instanceof RequestError) {
        setProblem(caught.message);
      } else {
        console.error("Counter work failed", caught);
        setProblem("Something went wrong on this phone. Reload the page; waiting stamps are kept.");
      }
    }
  }, []);

  const refreshStaff = useCallback(
    () =>
      handled(async () => {
        const { body, keyId } = await deviceRequestFor("GET", "/api/device/staff", deviceStaffSchema);
        // Only for the pairing the request was made for; a barista the owner removed is signed out.
        await storeStaff(keyId, body.staff);
        const catalog = await deviceRequestFor("GET", "/api/device/catalog", deviceCatalogSchema);
        await storeCatalog(catalog.keyId, catalog.body);
        setNotice(null);
      }),
    [handled],
  );

  const sync = useCallback(() => handled(syncQueue), [handled]);
  const device = stored?.device;
  const paired = device?.paired === true;
  /** The paired device's key: pairing again (even while paired) restarts syncing and loads its café's baristas. */
  const pairedKey = device?.paired === true ? device.keyId : undefined;
  const pending = stored?.pending ?? 0;

  useEffect(() => {
    if (pairedKey === undefined || !online) {
      return;
    }
    // Right away (once the effect has run), then on a timer.
    const first = setTimeout(() => void sync().then(refreshStaff), 0);
    const syncTimer = setInterval(() => void sync(), SYNC_INTERVAL_MS);
    const staffTimer = setInterval(() => void refreshStaff(), STAFF_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(syncTimer);
      clearInterval(staffTimer);
    };
  }, [pairedKey, online, sync, refreshStaff]);

  // A newly queued event (such as a lockout report) goes out at once when online.
  useEffect(() => {
    if (!paired || !online || pending === 0) {
      return;
    }
    const timer = setTimeout(() => void sync(), 0);
    return () => {
      clearTimeout(timer);
    };
  }, [paired, online, pending, sync]);

  const barista = stored?.staff.find((member) => member.id === stored.baristaId);
  const chosen = stored?.staff.find((member) => member.id === chosenId);
  let screen: Screen;
  if (stored === null) {
    screen = "loading";
  } else if (path === "/pair" || !paired) {
    screen = "pair";
  } else if (barista !== undefined) {
    screen = "home";
  } else if (chosen === undefined) {
    screen = "who";
  } else {
    screen = "pin";
  }

  // A new screen takes focus at its heading, so it is announced and the keyboard starts there.
  useEffect(() => {
    if (shownScreen.current !== null && shownScreen.current !== "loading") {
      screenRef.current?.querySelector<HTMLElement>("h2")?.focus();
    }
    shownScreen.current = screen;
  }, [screen]);

  let content: ReactNode;
  switch (screen) {
    case "loading":
      content = <p>Loading…</p>;
      break;
    case "pair":
      content = (
        <PairScreen
          device={stored?.device}
          waiting={pending}
          onBusy={setBusy}
          onPaired={() => {
            window.history.replaceState(null, "", "/");
            setPath("/");
            setChosenId(null);
            setBusy(false);
            setNotice(null);
          }}
        />
      );
      break;
    case "who":
      content = (
        <BaristaPicker
          staff={stored?.staff ?? []}
          online={online}
          onChoose={(member) => {
            setChosenId(member.id);
          }}
        />
      );
      break;
    case "pin":
      content =
        chosen === undefined ? null : (
          <PinScreen
            staff={chosen}
            onBusy={setBusy}
            onBack={() => {
              setChosenId(null);
            }}
            onSignedIn={() => {
              setBusy(false);
              setMeta("barista", { staffId: chosen.id }).then(
                () => {
                  setChosenId(null);
                },
                (caught: unknown) => {
                  console.error("Saving the barista failed", caught);
                  setProblem("Signing in could not be saved on this phone. Reload the page and try again.");
                },
              );
            }}
          />
        );
      break;
    case "home":
      content = (
        <section aria-labelledby="home-title">
          <h2 id="home-title" tabIndex={-1}>
            {stored?.device?.cafe.name}
          </h2>
          <p>
            Signed in as <strong>{barista?.name}</strong> on {stored?.device?.deviceName}.
          </p>
          {device === undefined || barista === undefined ? null : (
            <CounterScreen device={device} barista={barista} catalog={stored?.catalog} online={online} onBusy={setBusy} />
          )}
          <button
            type="button"
            onClick={() => {
              deleteMeta("barista").catch((caught: unknown) => {
                console.error("Signing out the barista failed", caught);
                setProblem("Switching barista failed on this phone. Reload the page and try again.");
              });
            }}
          >
            Switch barista
          </button>
        </section>
      );
      break;
  }

  return (
    <>
      <header>
        <h1>Cafe Loyalty Counter</h1>
      </header>
      <main>
        <div ref={screenRef}>{content}</div>
        <RejectedList rejected={stored?.rejected ?? []} />
      </main>
      <footer>
        <StatusBar online={online} pending={pending} problem={problem} notice={notice} update={update} />
      </footer>
    </>
  );
}
