import {
  bestCampaign,
  formatUsd,
  plural,
  normalizePhoneInput,
  parseCardQr,
  redemptionSchema,
  visitItemsTotalCents,
  visitRecordedV3PayloadSchema,
  winBackUnitDiscountCents,
  type DeviceCatalog,
  type Lang,
  type WinBackOffer,
} from "@cafe-loyalty/shared";
import { useEffect, useId, useRef, useState } from "react";
import { DeviceUnpairedError, RequestError, deviceRequest } from "./device.js";
import { dateFormat, useApiText, useLang, useT, type Translate } from "./i18n.js";
import { QrScanner } from "./scanner.js";
import { deleteMeta, getMeta, setMeta, type DeviceRecord, type MetaValues, type StaffEntry } from "./storage.js";
import { recordEvent } from "./sync.js";

const AR = {
  "That QR code is not a loyalty card. Scan the card the customer shows in their wallet or browser.":
    "رمز QR هذا ليس بطاقة ولاء. امسح البطاقة التي يُظهرها الزبون في محفظته أو متصفحه.",
  "That card is for another café. Ask for this café's card, or sign the customer up with the counter QR.":
    "هذه البطاقة لمقهى آخر. اطلب بطاقة هذا المقهى، أو سجّل الزبون عبر رمز QR الخاص بالكاونتر.",
  "Win-back offer": "عرض الاسترجاع",
  "{value}% off": "خصم {value}%",
  "{amount} off": "خصم {amount}",
  "Scan the customer's card, or enter their mobile number.": "امسح بطاقة الزبون، أو أدخل رقم هاتفه المحمول.",
  "Enter a Lebanese mobile number, such as 70 123 456.": "أدخل رقم هاتف محمول لبنانياً، مثل 70 123 456.",
  "Add what the customer ordered first.": "أضف ما طلبه الزبون أولاً.",
  "This order is too large to record. Split it into two visits.": "هذا الطلب أكبر من أن يُسجَّل. قسّمه على زيارتين.",
  "Visit saved, earning up to {stamps}. It is sent as soon as the phone is online.": "حُفظت الزيارة، وتكسب حتى {stamps}. تُرسل فور اتصال الهاتف بالإنترنت.",
  "Visit saved. It is sent as soon as the phone is online.": "حُفظت الزيارة. تُرسل فور اتصال الهاتف بالإنترنت.",
  "The visit could not be saved on this phone. Reload the page and record it again.": "تعذّر حفظ الزيارة على هذا الهاتف. أعد تحميل الصفحة وسجّلها مجدداً.",
  "Scan the customer's card": "امسح بطاقة الزبون",
  "customer's loyalty card QR code": "رمز QR لبطاقة ولاء الزبون",
  "Enter the customer's mobile number instead.": "أدخل رقم هاتف الزبون المحمول بدلاً من ذلك.",
  "New visit": "زيارة جديدة",
  "was ": "كان ",
  "now ": "الآن ",
  "One less {name}": "إنقاص {name} بواحد",
  "One more {name}": "زيادة {name} بواحد",
  "An item": "صنف",
  "No longer on sale, so left out of this order: {names}. The total does not include it.": "لم يعد معروضاً للبيع، فاستُبعد من هذا الطلب: {names}. المجموع لا يشمله.",
  "No longer on sale, so left out of this order: {names}. The total does not include them.": "لم تعد معروضة للبيع، فاستُبعدت من هذا الطلب: {names}. المجموع لا يشملها.",
  "This card has a win-back offer, {discount}: apply it": "لهذه البطاقة عرض استرجاع، {discount}: طبّقه",
  "The offer takes nothing off this order: a campaign already gives more, or it would sell below the margin floor. The card keeps the offer for its next visit.":
    "لا يخصم العرض شيئاً من هذا الطلب: إما أن حملة تعطي أكثر، وإما أنه سيبيع دون حد الهامش الأدنى. تحتفظ البطاقة بالعرض لزيارتها التالية.",
  "Total {total} · {stamps}": "المجموع {total} · {stamps}",
  "Scan card": "امسح البطاقة",
  "Card scanned.": "مُسحت البطاقة.",
  "Clear card": "إزالة البطاقة",
  "Or the customer's mobile number": "أو رقم هاتف الزبون المحمول",
  "Record visit": "تسجيل الزيارة",
  "A reward started at {time} was not confirmed. Press Try again to find out whether that customer got it, before giving another.":
    "لم تُؤكَّد مكافأة بدأت عند {time}. اضغط «حاول مجدداً» لمعرفة ما إذا حصل عليها ذلك الزبون، قبل إعطاء أخرى.",
  "This phone's storage could not be read, so an unconfirmed reward may be waiting. Reload the page before giving a reward.":
    "تعذّرت قراءة ذاكرة هذا الهاتف، فقد تكون هناك مكافأة غير مؤكَّدة. أعد تحميل الصفحة قبل إعطاء مكافأة.",
  "The reward could not be started on this phone. Reload the page and try again.": "تعذّر بدء المكافأة على هذا الهاتف. أعد تحميل الصفحة وحاول مجدداً.",
  "Reward given: {reward}. {left} left on the card.": "مُنحت المكافأة: {reward}. المتبقّي على البطاقة: {left}.",
  "The earlier reward, started at {time}, was given: {reward}. {left} left on that card. If that customer did not get it, tell the owner.":
    "المكافأة السابقة، التي بدأت عند {time}، مُنحت: {reward}. المتبقّي على تلك البطاقة: {left}. إذا لم يحصل عليها ذلك الزبون، فأخبر المالك.",
  "The reward started at {time} was not confirmed. Do not give it yet: check the connection, then press Try again.":
    "لم تُؤكَّد المكافأة التي بدأت عند {time}. لا تعطها بعد: تحقق من الاتصال، ثم اضغط «حاول مجدداً».",
  "The earlier reward, started at {time}, was not given: {reason}": "المكافأة السابقة، التي بدأت عند {time}، لم تُمنح: {reason}",
  "The reward could not be confirmed on this phone. Reload the page, then press Try again.": "تعذّر تأكيد المكافأة على هذا الهاتف. أعد تحميل الصفحة، ثم اضغط «حاول مجدداً».",
  "Give a reward": "إعطاء مكافأة",
  "{reward} for {stamps}.": "{reward} مقابل {stamps}.",
  "Rewards need the card scanned: give them from a phone with a camera.": "المكافآت تحتاج إلى مسح البطاقة: أعطها من هاتف فيه كاميرا.",
  "Rewards need an internet connection. Connect the phone, then try again.": "المكافآت تحتاج إلى اتصال بالإنترنت. صِل الهاتف بالإنترنت، ثم حاول مجدداً.",
  "Scan card for a reward": "امسح البطاقة لإعطاء مكافأة",
  "Loading the menu…": "جارٍ تحميل القائمة…",
  "Connect to the internet once to load the menu.": "اتصل بالإنترنت مرة واحدة لتحميل القائمة.",
  "Nothing is on sale yet. Ask the owner to add order types on the dashboard.": "لا شيء معروض للبيع بعد. اطلب من المالك إضافة أنواع الطلبات من لوحة التحكم.",
  "{answer} This phone could not forget the reward, so it may offer it again after a reload: do not give it twice.":
    "{answer} تعذّر على هذا الهاتف نسيان المكافأة، فقد يعرضها مجدداً بعد إعادة التحميل: لا تمنحها مرتين.",
} as const;

type T = Translate<typeof AR>;

const STAMPS = {
  en: { one: "{n} stamp", other: "{n} stamps" },
  ar: { zero: "{n} أختام", one: "ختم واحد", two: "ختمان", few: "{n} أختام", many: "{n} ختماً", other: "{n} ختم" },
};

/** Something with an Arabic and an English name, by the page's language. */
const nameIn = (lang: Lang, named: { nameAr: string; nameEn: string }): string => (lang === "ar" ? named.nameAr : named.nameEn);

type CardChoice = { kind: "qr"; token: string } | { kind: "phone"; phone: string };
type StoredRedemption = MetaValues["pendingRedemption"];
/** Which of the counter's two uses of the camera is open; only one at a time. */
type ScanPurpose = "visit" | "reward";

/** A scanned code that is a loyalty card of this café, or why it is not (read offline from the QR itself). */
function readCardQr(text: string, cafeId: string, t: T): { token: string } | { problem: string } {
  const fields = parseCardQr(text);
  if (fields === null) {
    return { problem: t("That QR code is not a loyalty card. Scan the card the customer shows in their wallet or browser.") };
  }
  if (fields.cafeId !== cafeId) {
    return { problem: t("That card is for another café. Ask for this café's card, or sign the customer up with the counter QR.") };
  }
  return { token: text };
}

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
 * barista applied it (`winBack`, the offer's own terms) and it gives more (AC 36). Null without a discount; `campaign`
 * is null for the win-back offer.
 */
export function discountFor(catalog: DeviceCatalog, type: DeviceCatalog["orderTypes"][number], at: Date, winBack: WinBackOffer | null) {
  const campaign = campaignFor(catalog, type, at);
  const offer = winBack === null ? 0 : winBackUnitDiscountCents(type, winBack);
  if (offer > 0 && offer > (campaign?.unitDiscountCents ?? 0)) {
    return { campaignId: null, unitDiscountCents: offer, campaign: null };
  }
  return campaign === null ? null : { campaignId: campaign.campaign.id, unitDiscountCents: campaign.unitDiscountCents, campaign: campaign.campaign };
}

/** A discount as the counter says it: "20% off" or "$0.50 off". */
const discountText = (discount: { kind: "percent" | "amount"; value: number }, t: T) =>
  discount.kind === "percent" ? t("{value}% off", { value: discount.value }) : t("{amount} off", { amount: formatUsd(discount.value, "en") });

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
  const t = useT(AR);
  const lang = useLang();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  /** The names of everything put in the order, to name it if the owner takes it off sale meanwhile. */
  const [names, setNames] = useState<Record<string, { nameAr: string; nameEn: string }>>({});
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
    .map(([id]) => {
      const named = names[id];
      return named === undefined ? t("An item") : nameIn(lang, named);
    });
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
  const change = (type: { id: string; nameAr: string; nameEn: string }, delta: number) => {
    setNotice("");
    setNames((current) => ({ ...current, [type.id]: { nameAr: type.nameAr, nameEn: type.nameEn } }));
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
          text: phone === "" ? t("Scan the customer's card, or enter their mobile number.") : t("Enter a Lebanese mobile number, such as 70 123 456."),
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
      setProblem({ text: items.length === 0 ? t("Add what the customer ordered first.") : t("This order is too large to record. Split it into two visits."), phone: false });
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
        setNotice(
          stamps > 0
            ? t("Visit saved, earning up to {stamps}. It is sent as soon as the phone is online.", { stamps: plural(lang, STAMPS, stamps) })
            : t("Visit saved. It is sent as soon as the phone is online."),
        );
      },
      (caught: unknown) => {
        console.error("Recording the visit failed", caught);
        setSaving(false);
        setProblem({ text: t("The visit could not be saved on this phone. Reload the page and record it again."), phone: false });
      },
    );
  };

  if (scanner === "visit") {
    return (
      <section aria-labelledby="scan-title" className="card">
        <h3 id="scan-title">{t("Scan the customer's card")}</h3>
        <QrScanner
          purpose={t("customer's loyalty card QR code")}
          noCamera={t("Enter the customer's mobile number instead.")}
          onCancel={() => {
            onScanner(null);
            requestAnimationFrame(() => scanButton.current?.focus());
          }}
          onScan={(text) => {
            onScanner(null);
            const read = readCardQr(text, device.cafe.id, t);
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
      <h3 id="visit-title">{t("New visit")}</h3>
      <ul className="menu">
        {catalog.orderTypes.map((type) => {
          const quantity = quantities[type.id] ?? 0;
          const offer = discountFor(catalog, type, shownAt, winBack);
          const name = nameIn(lang, type);
          return (
            <li key={type.id}>
              <span className="menu-item">
                <strong>{name}</strong> ·{" "}
                {offer === null ? (
                  formatUsd(type.priceCents, "en")
                ) : (
                  <>
                    <s>
                      <span className="visually-hidden">{t("was ")}</span>
                      {formatUsd(type.priceCents, "en")}
                    </s>{" "}
                    <span className="visually-hidden">{t("now ")}</span>
                    {formatUsd(type.priceCents - offer.unitDiscountCents, "en")} ({offer.campaign === null ? t("Win-back offer") : nameIn(lang, offer.campaign)})
                  </>
                )}
                {type.stampsEarned > 0 ? ` · ${plural(lang, STAMPS, type.stampsEarned)}` : ""}
              </span>
              <span className="stepper">
                <button
                  type="button"
                  aria-label={t("One less {name}", { name })}
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
                  aria-label={t("One more {name}", { name })}
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
            {dropped.length === 1
              ? t("No longer on sale, so left out of this order: {names}. The total does not include it.", { names: dropped.join(", ") })
              : t("No longer on sale, so left out of this order: {names}. The total does not include them.", { names: dropped.join(lang === "ar" ? "، " : ", ") })}
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
              {t("This card has a win-back offer, {discount}: apply it", { discount: discountText(offer.discount, t) })}
            </label>
            {winBack !== null && items.length > 0 && !linesAt(shownAt).some((line) => line.campaignId === null && line.unitDiscountCents > 0) ? (
              <p role="status">
                {t(
                  "The offer takes nothing off this order: a campaign already gives more, or it would sell below the margin floor. The card keeps the offer for its next visit.",
                )}
              </p>
            ) : null}
          </>
        )}
        <p aria-live="polite" className="total">
          {t("Total {total} · {stamps}", { total: formatUsd(total ?? 0, "en"), stamps: plural(lang, STAMPS, stamps) })}
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
              {t("Scan card")}
            </button>
          ) : (
            <p>
              {t("Card scanned.")}{" "}
              <button
                type="button"
                onClick={() => {
                  setScanned(null);
                  setApplyWinBack(false);
                  // The button that replaces this one keeps the keyboard where it was.
                  requestAnimationFrame(() => scanButton.current?.focus());
                }}
              >
                {t("Clear card")}
              </button>
            </p>
          )}
          {scanned === null ? (
            <div className="field">
              <label htmlFor={phoneId}>{t("Or the customer's mobile number")}</label>
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
          {saving ? t("Saving…") : t("Record visit")}
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

const startedAt = (lang: Lang, attempt: StoredRedemption) => dateFormat(lang, { timeStyle: "short" }).format(new Date(attempt.startedAt));

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
  const t = useT(AR);
  const api = useApiText();
  const lang = useLang();
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

  // Read once, in the language of the moment: the message is a snapshot like any other the panel shows.
  const loadText = useRef({ t, lang });
  useEffect(() => {
    let current = true;
    const { t: translate, lang: shownIn } = loadText.current;
    getMeta("pendingRedemption").then(
      (stored) => {
        if (current && stored !== undefined) {
          setPending({ ...stored, earlier: true });
          setMessage({
            text: translate("A reward started at {time} was not confirmed. Press Try again to find out whether that customer got it, before giving another.", {
              time: startedAt(shownIn, stored),
            }),
            problem: true,
          });
        }
      },
      (caught: unknown) => {
        console.error("Reading the unconfirmed reward failed", caught);
        if (current) {
          setMessage({ text: translate("This phone's storage could not be read, so an unconfirmed reward may be waiting. Reload the page before giving a reward."), problem: true });
        }
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
      finish(t("{answer} This phone could not forget the reward, so it may offer it again after a reload: do not give it twice.", { answer: text }), true);
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
      finish(t("The reward could not be started on this phone. Reload the page and try again."), true);
      return;
    }
    setPending(attempt);
    // One from before a reload may be for a customer who has left: the barista is told which one it was.
    const time = startedAt(lang, attempt);
    try {
      const redemption = await deviceRequest("POST", "/api/device/redemptions", redemptionSchema, { eventId: attempt.eventId, staffId: barista.id, cardQr: attempt.cardQr });
      const given = { reward: lang === "ar" ? redemption.rewardNameAr : redemption.rewardNameEn, left: plural(lang, STAMPS, redemption.stampsLeft) };
      settle(
        attempt.earlier
          ? t("The earlier reward, started at {time}, was given: {reward}. {left} left on that card. If that customer did not get it, tell the owner.", { ...given, time })
          : t("Reward given: {reward}. {left} left on the card.", given),
        false,
      );
    } catch (caught) {
      if (caught instanceof RequestError && caught.failure.retryable) {
        // Nothing sends it again by itself, and whether it was given is unknown until it is.
        finish(t("The reward started at {time} was not confirmed. Do not give it yet: check the connection, then press Try again.", { time }), true);
      } else if (caught instanceof RequestError || caught instanceof DeviceUnpairedError) {
        settle(attempt.earlier ? t("The earlier reward, started at {time}, was not given: {reason}", { time, reason: api(caught.message) }) : api(caught.message), true);
      } else {
        console.error("Redeeming failed", caught);
        finish(t("The reward could not be confirmed on this phone. Reload the page, then press Try again."), true);
      }
    }
  };

  if (catalog.program === null) {
    return null;
  }
  return (
    <section aria-labelledby="redeem-title" className="card">
      <h3 id="redeem-title">{t("Give a reward")}</h3>
      <p className="hint">
        {t("{reward} for {stamps}.", {
          reward: lang === "ar" ? catalog.program.rewardNameAr : catalog.program.rewardNameEn,
          stamps: plural(lang, STAMPS, catalog.program.stampsRequired),
        })}
      </p>
      {scanner === "reward" ? (
        <QrScanner
          purpose={t("customer's loyalty card QR code")}
          noCamera={t("Rewards need the card scanned: give them from a phone with a camera.")}
          onCancel={() => {
            onScanner(null);
            setRefocus((turn) => turn + 1);
          }}
          onScan={(text) => {
            onScanner(null);
            const read = readCardQr(text, device.cafe.id, t);
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
            {online ? "" : t("Rewards need an internet connection. Connect the phone, then try again.")}
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
              {t("Scan card for a reward")}
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
              {sending ? t("Sending…") : t("Try again")}
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
  const t = useT(AR);
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
    return <p className="empty">{online ? t("Loading the menu…") : t("Connect to the internet once to load the menu.")}</p>;
  }
  if (catalog.orderTypes.length === 0) {
    return <p className="empty">{t("Nothing is on sale yet. Ask the owner to add order types on the dashboard.")}</p>;
  }
  // Both stay mounted (an open order survives a reward); the other's scan button is disabled while one scans.
  return (
    <div className="counter-screen">
      <VisitForm device={device} barista={barista} catalog={catalog} scanner={scanner} onScanner={setScanner} onBusy={setVisitBusy} />
      <RedeemPanel device={device} barista={barista} catalog={catalog} online={online} scanner={scanner} onScanner={setScanner} onBusy={setRewardBusy} />
    </div>
  );
}
