import {
  PRODUCT_NAME,
  apiText,
  deviceCatalogSchema,
  deviceStaffSchema,
  normalizePairingCode,
  plural,
  toLatinDigits,
  type DeviceCatalog,
} from "@cafe-loyalty/shared";
import logoUrl from "@cafe-loyalty/ui/logo.svg";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DeviceUnpairedError, PairedElsewhereError, RequestError, deviceRequestFor, pairDevice } from "./device.js";
import { LangProvider, LanguageSwitch, dateFormat, useApiText, useLang, useT } from "./i18n.js";
import { PAGE_LOADED_AT, lastActivity } from "./idle.js";
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
  signOutIdle,
  storeCatalog,
  storeStaff,
  STORAGE_BUSY,
  touchBarista,
  type DeviceRecord,
  type MetaValues,
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

const AR = {
  Counter: "الكاونتر",
  "Build {id}": "الإصدار {id}",
  "Counter status": "حالة الكاونتر",
  Online: "متصل",
  "Offline: stamps are saved on this phone and sync when the connection returns.": "غير متصل: تُحفظ الأختام على هذا الهاتف وتُزامَن حين يعود الاتصال.",
  "Nothing waiting to send.": "لا شيء بانتظار الإرسال.",
  Offline: "غير متصل",
  "Can't reach server": "الخادم لا يجيب",
  "The phone is online but the server did not answer: stamps are saved on this phone and sent once it does.":
    "الهاتف متصل لكن الخادم لم يجب: تُحفظ الأختام على هذا الهاتف وتُرسل حين يجيب.",
  "Last sent {time}": "آخر إرسال {time}",
  "An update is ready. It installs once everything is sent and nobody is typing.": "تحديث جاهز. يُثبَّت بعد إرسال كل شيء وحين لا يكتب أحد.",
  Visit: "زيارة",
  "PIN lockout report": "تقرير قفل الرمز السري",
  "the card is not a card of this café; scan the customer's card again next time": "البطاقة ليست بطاقة لهذا المقهى؛ امسح بطاقة الزبون مجدداً في المرة القادمة",
  "the card was moved to another phone; ask the customer to show the card on their new phone": "نُقلت البطاقة إلى هاتف آخر؛ اطلب من الزبون إظهار البطاقة على هاتفه الجديد",
  "this number is not confirmed yet; scan the customer's card once, then their number works too": "هذا الرقم غير مؤكَّد بعد؛ امسح بطاقة الزبون مرة واحدة، فيعمل رقمه بعدها أيضاً",
  "another card at this café signed up with this number, so it cannot be stamped by number; scan the customer's card":
    "سُجّلت بطاقة أخرى في هذا المقهى بهذا الرقم، فلا يمكن الختم بالرقم؛ امسح بطاقة الزبون",
  "something ordered is no longer on the café's menu; record the visit again without it": "أحد الأصناف المطلوبة لم يعد في قائمة المقهى؛ سجّل الزيارة مجدداً من دونه",
  "its discount named a campaign this café does not have; record the visit again": "خصمها ذكر حملة لا يملكها هذا المقهى؛ سجّل الزيارة مجدداً",
  "the server could not accept it as recorded": "لم يستطع الخادم قبولها كما سُجّلت",
  "this phone's signature did not check out": "لم يتحقق توقيع هذا الهاتف",
  "the phone's clock was wrong; set its date and time to automatic": "كانت ساعة الهاتف خاطئة؛ اضبط تاريخه ووقته على التلقائي",
  "it clashed with something this phone sent before": "تعارضت مع شيء أرسله هذا الهاتف من قبل",
  "refused ({code})": "رُفضت ({code})",
  "{event} from {time}: {reason}.": "{event} من {time}: {reason}.",
  "Not accepted by the server": "لم يقبلها الخادم",
  "These were not recorded. Show this list to the owner.": "لم تُسجَّل هذه. أظهر هذه القائمة للمالك.",
  "The list could not be cleared. Reload the page and try again.": "تعذّر مسح القائمة. أعد تحميل الصفحة وحاول مجدداً.",
  "Clear list": "مسح القائمة",
  "Pairing failed on this phone. Reload the page and try again.": "فشل الربط على هذا الهاتف. أعد تحميل الصفحة وحاول مجدداً.",
  "The owner removed this phone. Ask them for a new pairing code to use it again. Its waiting stamps are kept and sent once it is paired.":
    "أزال المالك هذا الهاتف. اطلب منه رمز ربط جديداً لاستخدامه مجدداً. الأختام المنتظرة محفوظة وتُرسل بعد ربطه.",
  "This phone was offline too long and must be paired again. Its waiting stamps are kept and sent once it is paired.":
    "بقي هذا الهاتف دون اتصال مدة طويلة ويجب ربطه مجدداً. الأختام المنتظرة محفوظة وتُرسل بعد ربطه.",
  "This phone is paired as {device} at {cafe}. Pairing it again replaces that.": "هذا الهاتف مربوط باسم {device} في {cafe}. ربطه مجدداً يستبدل ذلك.",
  "Pair this phone": "اربط هذا الهاتف",
  "On the owner's dashboard, open Devices and create a pairing code. Scan its QR code with this phone's camera, or type the code here.":
    "في لوحة تحكم المالك، افتح «الأجهزة» وأنشئ رمز ربط. امسح رمز QR الخاص به بكاميرا هذا الهاتف، أو اكتب الرمز هنا.",
  "This phone is still paired with {cafe} and has 1 item waiting to send there. Pair it with {cafe} first to send it. Starting over here discards it for good.":
    "هذا الهاتف لا يزال مربوطاً بـ{cafe} وفيه عنصر واحد بانتظار الإرسال إليه. اربطه بـ{cafe} أولاً لإرساله. البدء من جديد هنا يحذفه نهائياً.",
  "This phone is still paired with {cafe} and has {items} waiting to send there. Pair it with {cafe} first to send them. Starting over here discards them for good.":
    "هذا الهاتف لا يزال مربوطاً بـ{cafe} وفيه {items} بانتظار الإرسال إليه. اربطه بـ{cafe} أولاً لإرسالها. البدء من جديد هنا يحذفها نهائياً.",
  "Start over and discard it": "ابدأ من جديد واحذفه",
  "Start over and discard them": "ابدأ من جديد واحذفها",
  "Pairing code": "رمز الربط",
  "Pairing…": "جارٍ الربط…",
  "This phone's storage could not be read. Reload the page and try again.": "تعذّرت قراءة ذاكرة هذا الهاتف. أعد تحميل الصفحة وحاول مجدداً.",
  "Too many wrong PINs. {name} can try again at {time}.": "رموز سرية خاطئة كثيرة. يمكن لـ{name} المحاولة مجدداً عند {time}.",
  "PIN for {name}": "الرمز السري لـ{name}",
  "Enter the 6 to 12 digit PIN the owner set for you.": "أدخل الرمز السري المؤلف من 6 إلى 12 رقماً الذي حدّده لك المالك.",
  "The PIN could not be checked on this phone. Reload the page and try again.": "تعذّر التحقق من الرمز السري على هذا الهاتف. أعد تحميل الصفحة وحاول مجدداً.",
  PIN: "الرمز السري",
  "Checking…": "جارٍ التحقق…",
  "Sign in": "تسجيل الدخول",
  Back: "رجوع",
  "Who is working?": "من يعمل الآن؟",
  "No baristas yet. Ask the owner to add staff on the dashboard.": "لا باريستا بعد. اطلب من المالك إضافة الموظفين من لوحة التحكم.",
  "Connect to the internet once to load the baristas.": "اتصل بالإنترنت مرة واحدة لتحميل قائمة الباريستا.",
  "This phone's storage could not be read. Reload the page; if it keeps failing, check that the browser allows site data.":
    "تعذّرت قراءة ذاكرة هذا الهاتف. أعد تحميل الصفحة؛ وإذا تكرر الفشل، فتحقق من أن المتصفح يسمح ببيانات المواقع.",
  "Something went wrong on this phone. Reload the page; waiting stamps are kept.": "حدث خطأ على هذا الهاتف. أعد تحميل الصفحة؛ الأختام المنتظرة محفوظة.",
  "Signing in could not be saved on this phone. Reload the page and try again.": "تعذّر حفظ تسجيل الدخول على هذا الهاتف. أعد تحميل الصفحة وحاول مجدداً.",
  "Signed in as {name} on {device}.": "مسجّل الدخول باسم {name} على {device}.",
  "Switching barista failed on this phone. Reload the page and try again.": "فشل تبديل الباريستا على هذا الهاتف. أعد تحميل الصفحة وحاول مجدداً.",
  "Switch barista": "تبديل الباريستا",
  "The barista was signed out after 4 hours without use.": "سُجّل خروج الباريستا بعد 4 ساعات دون استخدام.",
  "An order is open. Switching barista clears it.": "هناك طلب مفتوح. تبديل الباريستا يمسحه.",
  "Switch and clear the order": "بدّل وامسح الطلب",
  "Keep the order": "أبقِ الطلب",
} as const;

/** How long a barista stays signed in without anyone using the counter (owner's decision, K3). */
export const BARISTA_IDLE_MS = 4 * 60 * 60 * 1000;

type AppText = keyof typeof AR;

/**
 * Text kept in state in English, in the page's language when shown: the counter's own (this file's catalog) or the
 * API's, so a message already on screen follows a language switch.
 */
function useSay(): (text: string) => string {
  const t = useT(AR);
  const api = useApiText();
  return (text) => (Object.hasOwn(AR, text) ? t(text as AppText) : api(text));
}

/** What waits to be sent, short enough for the one-row header beside the connection. */
const WAITING = {
  en: { one: "{n} to send", other: "{n} to send" },
  ar: { one: "واحد للإرسال", two: "اثنان للإرسال", few: "{n} للإرسال", many: "{n} للإرسال", other: "{n} للإرسال" },
};
/** Events the server refused for good, in the header's chip: a link to their list. */
const REFUSED = {
  en: { one: "{n} refused", other: "{n} refused" },
  ar: { one: "واحد مرفوض", two: "اثنان مرفوضان", few: "{n} مرفوضة", many: "{n} مرفوضاً", other: "{n} مرفوض" },
};
const ITEMS = { en: { one: "{n} item", other: "{n} items" }, ar: { one: "عنصر واحد", two: "عنصران", few: "{n} عناصر", many: "{n} عنصراً", other: "{n} عنصر" } };
const TRIES = {
  en: { one: "Wrong PIN. {n} try left before a pause.", other: "Wrong PIN. {n} tries left before a pause." },
  ar: {
    one: "رمز سري خاطئ. بقيت محاولة واحدة قبل الإيقاف المؤقت.",
    two: "رمز سري خاطئ. بقيت محاولتان قبل الإيقاف المؤقت.",
    few: "رمز سري خاطئ. بقيت {n} محاولات قبل الإيقاف المؤقت.",
    other: "رمز سري خاطئ. بقيت {n} محاولة قبل الإيقاف المؤقت.",
  },
};

interface Stored {
  device: DeviceRecord | undefined;
  staff: StaffEntry[];
  baristaId: string | undefined;
  baristaLastActiveAt: number | undefined;
  pending: number;
  rejected: RejectedEvent[];
  catalog: DeviceCatalog | undefined;
  lastVisit: MetaValues["lastVisit"] | undefined;
}

async function readStored(): Promise<Stored> {
  const [device, staff, barista, pending, rejected, catalog, lastVisit] = await Promise.all([
    getMeta("device"),
    getMeta("staff"),
    getMeta("barista"),
    countQueued(),
    listRejected(),
    getMeta("catalog"),
    getMeta("lastVisit"),
  ]);
  // A catalog an older build stored has no campaigns (nor their time zone) or win-back offers: none apply until the next
  // refresh.
  return {
    device,
    staff: staff ?? [],
    baristaId: barista?.staffId,
    baristaLastActiveAt: barista?.lastActiveAt,
    pending,
    rejected,
    catalog: catalog && { ...catalog, timeZone: catalog.timeZone ?? "UTC", campaigns: catalog.campaigns ?? [], winBackOffers: catalog.winBackOffers ?? [] },
    lastVisit,
  };
}

const EVENT_LABELS: Readonly<Record<string, AppText>> = { "visit.recorded": "Visit", "staff.pin_lockout": "PIN lockout report" };

const REJECTION_REASONS: Readonly<Record<string, AppText>> = {
  CARD_NOT_FOUND: "the card is not a card of this café; scan the customer's card again next time",
  CARD_REPLACED: "the card was moved to another phone; ask the customer to show the card on their new phone",
  PHONE_NOT_CONFIRMED: "this number is not confirmed yet; scan the customer's card once, then their number works too",
  PHONE_DISPUTED: "another card at this café signed up with this number, so it cannot be stamped by number; scan the customer's card",
  UNKNOWN_ORDER_TYPE: "something ordered is no longer on the café's menu; record the visit again without it",
  CAMPAIGN_REFUSED: "its discount named a campaign this café does not have; record the visit again",
  INVALID_EVENT: "the server could not accept it as recorded",
  SIGNATURE_INVALID: "this phone's signature did not check out",
  CLOCK_SKEW: "the phone's clock was wrong; set its date and time to automatic",
  IDEMPOTENCY_CONFLICT: "it clashed with something this phone sent before",
};

/** What a proxy answers, in a page of its own (no error code), when the server behind it is down or restarting. */
const GATEWAY_DOWN = new Set([502, 503, 504]);

/** How the last attempt to send went: whether the server answered, and when events were last sent (ms), if ever. */
interface SyncHealth {
  failed: boolean;
  sentAt: number | null;
}

/**
 * Always visible in the header, in one short chip: connectivity and what waits to be sent, nothing included (AC 29).
 * Offline, or online while the server does not answer (Wi-Fi with no internet), the chip says so in a word and screen
 * readers hear the whole sentence; an empty queue shows "0 to send" and is read as "Nothing waiting to send.". It
 * shows when events were last sent (on a wide screen; screen readers always), and links to any the server refused.
 */
function ConnectionStatus({ online, pending, health, refused }: { online: boolean; pending: number; health: SyncHealth; refused: number }) {
  const t = useT(AR);
  const lang = useLang();
  const reached = online && !health.failed;
  return (
    <section aria-label={t("Counter status")} className={`connection ${reached ? "is-online" : "is-offline"}`}>
      <p role="status" aria-live="polite">
        {reached ? (
          t("Online")
        ) : online ? (
          <>
            <span aria-hidden="true">{t("Can't reach server")}</span>
            <span className="visually-hidden">{t("The phone is online but the server did not answer: stamps are saved on this phone and sent once it does.")}</span>
          </>
        ) : (
          <>
            <span aria-hidden="true">{t("Offline")}</span>
            <span className="visually-hidden">{t("Offline: stamps are saved on this phone and sync when the connection returns.")}</span>
          </>
        )}
      </p>
      {/* Not live: it changes with every sync, and the count is there to look at, not to hear. */}
      <p className="queue">
        {pending === 0 ? (
          <>
            <span aria-hidden="true">{plural(lang, WAITING, 0)}</span>
            <span className="visually-hidden">{t("Nothing waiting to send.")}</span>
          </>
        ) : (
          plural(lang, WAITING, pending)
        )}
      </p>
      {health.sentAt === null ? null : (
        <p className="sent">{t("Last sent {time}", { time: dateFormat(lang, { timeStyle: "short" }).format(new Date(health.sentAt)) })}</p>
      )}
      {refused === 0 ? null : (
        <a className="refused" href="#rejected-title">
          {plural(lang, REFUSED, refused)}
        </a>
      )}
    </section>
  );
}

/** Problems, notices and updates, under the header so they are seen (AC 29). */
function StatusMessages({ problem, notice, info, update }: { problem: string | null; notice: string | null; info: string | null; update: UpdateState }) {
  const t = useT(AR);
  const say = useSay();
  // Always in the page, so screen readers announce what appears in it.
  return (
    <div aria-live="polite" className="messages">
      {problem === null ? null : <p className="warning-box">{say(problem)}</p>}
      {notice === null ? null : <p className="warning-box">{say(notice)}</p>}
      {info === null ? null : <p className="notice">{say(info)}</p>}
      {update.waiting ? <p className="notice">{t("An update is ready. It installs once everything is sent and nobody is typing.")}</p> : null}
      {update.error === null ? null : <p className="warning-box">{say(update.error)}</p>}
    </div>
  );
}

/** Events the server refused for good, kept on screen until cleared (AC 23). */
function RejectedList({ rejected }: { rejected: RejectedEvent[] }) {
  const t = useT(AR);
  const say = useSay();
  const lang = useLang();
  const [error, setError] = useState<string | null>(null);
  if (rejected.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="rejected-title" className="rejected form-error">
      {/* Focusable, so the header's link moves the keyboard here too. */}
      <h2 id="rejected-title" tabIndex={-1}>
        {t("Not accepted by the server")}
      </h2>
      <p>{t("These were not recorded. Show this list to the owner.")}</p>
      <ul>
        {rejected.map((entry) => {
          const label = EVENT_LABELS[entry.type];
          const reason = REJECTION_REASONS[entry.code];
          return (
            <li key={entry.eventId}>
              {t("{event} from {time}: {reason}.", {
                event: label === undefined ? entry.type : t(label),
                time: dateFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.occurredAt)),
                reason: reason === undefined ? t("refused ({code})", { code: entry.code }) : t(reason),
              })}
            </li>
          );
        })}
      </ul>
      {error === null ? null : <p role="alert">{say(error)}</p>}
      <button
        type="button"
        onClick={() => {
          clearRejected().catch((caught: unknown) => {
            console.error("Clearing the error list failed", caught);
            setError("The list could not be cleared. Reload the page and try again." satisfies AppText);
          });
        }}
      >
        {t("Clear list")}
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
  const t = useT(AR);
  const say = useSay();
  const lang = useLang();
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
          setError("Pairing failed on this phone. Reload the page and try again." satisfies AppText);
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
    intro = (
      <p className="warning-box">
        {t("The owner removed this phone. Ask them for a new pairing code to use it again. Its waiting stamps are kept and sent once it is paired.")}
      </p>
    );
  } else if (device?.unpairedReason === "pairing_required") {
    intro = <p className="warning-box">{t("This phone was offline too long and must be paired again. Its waiting stamps are kept and sent once it is paired.")}</p>;
  } else if (device?.paired === true) {
    intro = <p>{t("This phone is paired as {device} at {cafe}. Pairing it again replaces that.", { device: device.deviceName, cafe: device.cafe.name })}</p>;
  }

  return (
    <section aria-labelledby="pair-title" className="card screen-card">
      <h2 id="pair-title" tabIndex={-1}>
        {t("Pair this phone")}
      </h2>
      {intro}
      <p className="hint">
        {t("On the owner's dashboard, open Devices and create a pairing code. Scan its QR code with this phone's camera, or type the code here.")}
      </p>
      {elsewhere === null ? null : (
        <div role="alert" className="warning-box">
          <p>
            {waiting === 1
              ? t("This phone is still paired with {cafe} and has 1 item waiting to send there. Pair it with {cafe} first to send it. Starting over here discards it for good.", {
                  cafe: elsewhere.cafeName,
                })
              : t(
                  "This phone is still paired with {cafe} and has {items} waiting to send there. Pair it with {cafe} first to send them. Starting over here discards them for good.",
                  { cafe: elsewhere.cafeName, items: plural(lang, ITEMS, waiting) },
                )}
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
              {waiting === 1 ? t("Start over and discard it") : t("Start over and discard them")}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setElsewhere(null);
              }}
            >
              {t("Cancel")}
            </button>
          </div>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = normalizePairingCode(code);
          if (normalized === null) {
            setError(apiText("Enter the 12-character code shown on the owner's dashboard."));
            return;
          }
          pair(normalized, false);
        }}
      >
        <label htmlFor={inputId}>{t("Pairing code")}</label>
        <input
          id={inputId}
          className="code-input"
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
            {say(error)}
          </p>
        )}
        <button type="submit" disabled={pending}>
          {pending ? t("Pairing…") : t("Pair this phone")}
        </button>
      </form>
    </section>
  );
}

function PinScreen({ staff, onSignedIn, onBack, onBusy }: { staff: StaffEntry; onSignedIn: () => void; onBack: () => void; onBusy: (busy: boolean) => void }) {
  const t = useT(AR);
  const say = useSay();
  const lang = useLang();
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
          setMessage("This phone's storage could not be read. Reload the page and try again." satisfies AppText);
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
  const shown = locked
    ? t("Too many wrong PINs. {name} can try again at {time}.", { name: staff.name, time: dateFormat(lang, { timeStyle: "short" }).format(new Date(lockedUntil)) })
    : message === null
      ? null
      : say(message);

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
    <section aria-labelledby="pin-title" className="card screen-card">
      <h2 id="pin-title" tabIndex={-1} ref={heading}>
        {t("PIN for {name}", { name: staff.name })}
      </h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          // Arabic-Indic digits are the same digits (pinMatches reads them so too).
          if (!/^\d{6,12}$/.test(toLatinDigits(pin))) {
            setMessage("Enter the 6 to 12 digit PIN the owner set for you." satisfies AppText);
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
                setMessage(plural(lang, TRIES, attempt.attemptsLeft));
              }
            },
            (caught: unknown) => {
              console.error("Checking the PIN failed", caught);
              setChecking(false);
              setMessage("The PIN could not be checked on this phone. Reload the page and try again." satisfies AppText);
            },
          );
        }}
      >
        <label htmlFor={inputId}>{t("PIN")}</label>
        <input
          ref={input}
          id={inputId}
          className="pin-input"
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
          <p id={messageId} role="alert" className={locked ? "warning-box" : "field-error"}>
            {shown}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={checking || locked}>
            {checking ? t("Checking…") : t("Sign in")}
          </button>
          <button type="button" onClick={onBack}>
            {t("Back")}
          </button>
        </div>
      </form>
    </section>
  );
}

function BaristaPicker({ staff, online, onChoose }: { staff: StaffEntry[]; online: boolean; onChoose: (staff: StaffEntry) => void }) {
  const t = useT(AR);
  return (
    <section aria-labelledby="who-title" className="who">
      <h2 id="who-title" tabIndex={-1}>
        {t("Who is working?")}
      </h2>
      {staff.length === 0 ? (
        <p className="empty">{online ? t("No baristas yet. Ask the owner to add staff on the dashboard.") : t("Connect to the internet once to load the baristas.")}</p>
      ) : (
        <ul className="staff-tiles">
          {staff.map((member) => (
            <li key={member.id}>
              <button
                type="button"
                onClick={() => {
                  onChoose(member);
                }}
              >
                <span className="initial" aria-hidden="true">
                  {Array.from(member.name)[0]?.toUpperCase()}
                </span>
                <bdi>{member.name}</bdi>
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
  return (
    <LangProvider>
      <Counter />
    </LangProvider>
  );
}

function Counter() {
  const t = useT(AR);
  const appName = t("Counter");
  useEffect(() => {
    document.title = `${PRODUCT_NAME} ${appName}`;
  }, [appName]);
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
      if (caught instanceof Error && caught.message === STORAGE_BUSY) {
        setProblem(STORAGE_BUSY);
        return;
      }
      setProblem("This phone's storage could not be read. Reload the page; if it keeps failing, check that the browser allows site data." satisfies AppText);
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
        setProblem("Something went wrong on this phone. Reload the page; waiting stamps are kept." satisfies AppText);
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

  const [health, setHealth] = useState<SyncHealth>({ failed: false, sentAt: null });
  /** The first held event's time to be sent (a visit kept back for its Undo), as a new object each sync, so it is waited for again. */
  const [held, setHeld] = useState<{ until: number } | null>(null);
  const sync = useCallback(
    () =>
      handled(async () => {
        try {
          const summary = await syncQueue();
          setHealth((current) => ({ failed: false, sentAt: summary.settled > 0 ? Date.now() : current.sentAt }));
          setHeld(summary.heldUntil === undefined ? null : { until: summary.heldUntil });
        } catch (caught) {
          // The chip says the server cannot be reached only when nothing answered: no response, or a proxy's page while
          // the server is down. An answer (an error, a refusal, one this build cannot read) is said by its own message.
          if (caught instanceof RequestError || caught instanceof DeviceUnpairedError) {
            const unreached = caught instanceof RequestError && caught.failure.code === null && (caught.failure.status === null || GATEWAY_DOWN.has(caught.failure.status));
            setHealth((current) => ({ ...current, failed: unreached }));
          }
          throw caught;
        }
      }),
    [handled],
  );
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

  // A held visit goes out as soon as its Undo ends (a little after, so it is no longer held when sync looks).
  useEffect(() => {
    if (!paired || !online || held === null) {
      return;
    }
    const timer = setTimeout(() => void sync(), Math.max(held.until - Date.now(), 0) + 50);
    return () => {
      clearTimeout(timer);
    };
  }, [paired, online, held, sync]);

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

  /** An order is open on the counter screen: switching barista asks first, as it clears it (K11). */
  const [orderOpen, setOrderOpen] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  /** Said under the header until the next barista signs in: why the last one was signed out. */
  const [signedOut, setSignedOut] = useState<string | null>(null);
  const switchButton = useRef<HTMLButtonElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  /** Signs the barista out through `clear`, which says whether it did (an idle sign-out may find them used meanwhile). */
  const signOut = useCallback(
    (why: string | null, clear: () => Promise<boolean> = () => deleteMeta("barista").then(() => true)) => {
      clear().then(
        (out) => {
          if (out) {
            setConfirmSwitch(false);
            setOrderOpen(false);
            setSignedOut(why);
          }
        },
        (caught: unknown) => {
          console.error("Signing out the barista failed", caught);
          setProblem("Switching barista failed on this phone. Reload the page and try again." satisfies AppText);
        },
      );
    },
    [],
  );

  // Signed out after 4 hours with nobody using the counter, so the next shift's stamps are not credited to them (K3).
  // The last use is stored at most a minute behind, so a reload does not restart the 4 hours.
  const baristaId = stored?.baristaId;
  const lastActiveAt = stored?.baristaLastActiveAt;
  useEffect(() => {
    if (screen !== "home" || baristaId === undefined) {
      return;
    }
    const check = () => {
      const seen = Math.max(lastActivity(), lastActiveAt ?? PAGE_LOADED_AT);
      if (Date.now() - seen >= BARISTA_IDLE_MS) {
        // Checked again in storage: another tab may have stored a later use, or signed someone else in, meanwhile.
        const usedBefore = Date.now() - BARISTA_IDLE_MS;
        signOut("The barista was signed out after 4 hours without use." satisfies AppText, () => signOutIdle(baristaId, usedBefore));
      } else if (lastActivity() - (lastActiveAt ?? 0) >= 60_000) {
        touchBarista(baristaId, lastActivity()).catch((caught: unknown) => {
          console.error("Keeping the barista's last use failed", caught);
        });
      }
    };
    check();
    const timer = setInterval(check, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, [screen, baristaId, lastActiveAt, signOut]);

  // The confirmation takes the keyboard to its safe choice; keeping the order brings it back to Switch barista.
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirmSwitch) {
      keepButton.current?.focus();
    } else if (wasConfirming.current) {
      switchButton.current?.focus();
    }
    wasConfirming.current = confirmSwitch;
  }, [confirmSwitch]);

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
      content = <p className="empty">{t("Loading…")}</p>;
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
              setMeta("barista", { staffId: chosen.id, lastActiveAt: Date.now() }).then(
                () => {
                  setChosenId(null);
                  setSignedOut(null);
                },
                (caught: unknown) => {
                  console.error("Saving the barista failed", caught);
                  setProblem("Signing in could not be saved on this phone. Reload the page and try again." satisfies AppText);
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
          <div className="session-bar">
            <p>
              {t("Signed in as {name} on {device}.", { name: barista?.name ?? "", device: stored?.device?.deviceName ?? "" })}
            </p>
            <button
              ref={switchButton}
              type="button"
              onClick={() => {
                if (orderOpen) {
                  setConfirmSwitch(true);
                } else {
                  signOut(null);
                }
              }}
            >
              {t("Switch barista")}
            </button>
          </div>
          {confirmSwitch ? (
            <div role="alert" className="warning-box switch-confirm">
              <p>{t("An order is open. Switching barista clears it.")}</p>
              <div className="actions">
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    signOut(null);
                  }}
                >
                  {t("Switch and clear the order")}
                </button>
                <button
                  ref={keepButton}
                  type="button"
                  onClick={() => {
                    setConfirmSwitch(false);
                  }}
                >
                  {t("Keep the order")}
                </button>
              </div>
            </div>
          ) : null}
          {device === undefined || barista === undefined ? null : (
            <CounterScreen
              device={device}
              barista={barista}
              catalog={stored?.catalog}
              online={online}
              onBusy={setBusy}
              onOrderOpen={setOrderOpen}
              lastVisit={stored?.lastVisit}
            />
          )}
        </section>
      );
      break;
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <img src={logoUrl} alt="" width={36} height={36} />
          <h1>
            {/* The product name is a Latin brand in both languages. */}
            <span lang="en" dir="ltr">
              {PRODUCT_NAME}
            </span>{" "}
            <span className="brand-app">{appName}</span>
          </h1>
        </div>
        <ConnectionStatus online={online} pending={pending} health={health} refused={stored?.rejected.length ?? 0} />
        <LanguageSwitch />
      </header>
      <main>
        <StatusMessages problem={problem} notice={notice} info={signedOut} update={update} />
        <div ref={screenRef}>{content}</div>
        <RejectedList rejected={stored?.rejected ?? []} />
      </main>
      <footer className="app-footer">
        <p>{t("Build {id}", { id: __BUILD_ID__ })}</p>
      </footer>
    </>
  );
}
