import {
  bestCampaign,
  cardStatusSchema,
  formatUsd,
  localiseApiMessage,
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
import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { DeviceUnpairedError, RequestError, deviceRequest } from "./device.js";
import { dateFormat, useLang, useT, type Later, type Translate } from "./i18n.js";
import { QrScanner } from "./scanner.js";
import { deleteMeta, getMeta, setMeta, unqueue, type DeviceRecord, type MetaValues, type StaffEntry } from "./storage.js";
import { recordEvent } from "./sync.js";

const AR = {
  "That QR code is not a loyalty card. Scan the card the customer shows in their wallet or browser.":
    "رمز QR هذا ليس بطاقة ولاء. امسح البطاقة التي يُظهرها الزبون في محفظته أو متصفحه.",
  "That card is for another café. Ask for this café's card, or sign the customer up with the counter QR.":
    "هذه البطاقة لمقهى آخر. اطلب بطاقة هذا المقهى، أو سجّل الزبون عبر رمز QR الخاص بالكاونتر.",
  "Welcome-back offer": "عرض العودة",
  "{value}% off": "خصم {value}%",
  "{amount} off": "خصم {amount}",
  "Scan the customer's card, or enter their mobile number.": "امسح بطاقة الزبون، أو أدخل رقم هاتفه المحمول.",
  // The example number in left-to-right isolates: in Arabic text, digit groups split by spaces read right to left.
  "Enter a Lebanese mobile number, such as 70 123 456.": "أدخل رقم هاتف محمول لبنانياً، مثل ⁦70 123 456⁩.",
  "Add what the customer ordered first.": "أضف ما طلبه الزبون أولاً.",
  "This order is too large to record. Split it into two visits.": "هذا الطلب أكبر من أن يُسجَّل. قسّمه على زيارتين.",
  "Visit saved, earning up to {stamps}. It is sent as soon as the phone is online.": "حُفظت الزيارة، وتكسب حتى {stamps}. تُرسل فور اتصال الهاتف بالإنترنت.",
  "Visit saved. It is sent as soon as the phone is online.": "حُفظت الزيارة. تُرسل فور اتصال الهاتف بالإنترنت.",
  "Visit saved, earning up to {stamps}. Sending it now.": "حُفظت الزيارة، وتكسب حتى {stamps}. جارٍ إرسالها الآن.",
  "Visit saved. Sending it now.": "حُفظت الزيارة. جارٍ إرسالها الآن.",
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
  "Apply the welcome-back offer: {discount}": "طبّق عرض العودة: {discount}",
  "The offer takes nothing off this order: a campaign already gives more, or it would sell below the margin floor. The card keeps the offer for its next visit.":
    "لا يخصم العرض شيئاً من هذا الطلب: إما أن حملة تعطي أكثر، وإما أنه سيبيع دون حد الهامش الأدنى. تحتفظ البطاقة بالعرض لزيارتها التالية.",
  "Total {total} · {stamps}": "المجموع {total} · {stamps}",
  "Scan card": "امسح البطاقة",
  "Card scanned.": "مُسحت البطاقة.",
  "Clear card": "إزالة البطاقة",
  "No card? The customer's mobile number": "لا بطاقة؟ رقم هاتف الزبون المحمول",
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
  Undo: "تراجع",
  "Undo the visit": "التراجع عن الزيارة",
  "It can be undone for 10 seconds.": "يمكن التراجع عنها خلال 10 ثوانٍ.",
  "Visit undone. Change the order and record it again.": "أُلغيت الزيارة. عدّل الطلب وسجّله مجدداً.",
  "Too late to undo: the visit is sent or on its way. Tell the owner, who can fix it in Review.":
    "فات وقت التراجع: أُرسلت الزيارة أو هي في طريقها. أخبر المالك، فهو يستطيع تصحيحها من «المراجعة».",
  "The visit could not be undone on this phone. Tell the owner, who can fix it in Review.": "تعذّر التراجع عن الزيارة على هذا الهاتف. أخبر المالك، فهو يستطيع تصحيحها من «المراجعة».",
  "Records it for {phone}.": "تُسجَّل للرقم {phone}.",
  "The open order was cleared after 5 minutes without use.": "مُسح الطلب المفتوح بعد 5 دقائق دون استخدام.",
  "The camera turned off after a minute without a card. Press Scan card when the customer is ready.":
    "أُطفئت الكاميرا بعد دقيقة دون بطاقة. اضغط «امسح البطاقة» حين يكون الزبون جاهزاً.",
  "The camera turned off after a minute without a card. Press Scan card for a reward when the customer is ready.":
    "أُطفئت الكاميرا بعد دقيقة دون بطاقة. اضغط «امسح البطاقة لإعطاء مكافأة» حين يكون الزبون جاهزاً.",
  "Last visit, at {time}: recorded.": "آخر زيارة، عند {time}: سُجّلت.",
  "Last visit, at {time}: recorded with no stamps, because the card got stamps less than 30 minutes before.":
    "آخر زيارة، عند {time}: سُجّلت دون أختام، لأن البطاقة حصلت على أختام قبل أقل من 30 دقيقة.",
  "Last visit, at {time}: recorded with no stamps, because this phone reached its stamps for today. Tell the owner.":
    "آخر زيارة، عند {time}: سُجّلت دون أختام، لأن هذا الهاتف بلغ حدّ أختامه لهذا اليوم. أخبر المالك.",
  "Last visit, at {time}: recorded with no stamps, because the card was deleted.": "آخر زيارة، عند {time}: سُجّلت دون أختام، لأن البطاقة حُذفت.",
  "Last visit, at {time}: held for the owner to check; its stamps wait until the owner accepts it.":
    "آخر زيارة، عند {time}: أُوقفت ليراجعها المالك؛ تنتظر أختامها حتى يقبلها المالك.",
  "Reward ready: {reward}.": "المكافأة جاهزة: {reward}.",
  "Give {reward} now": "أعطِ {reward} الآن",
  "Finish the reward waiting under Give a reward first: press Try again there.": "أنهِ أولاً المكافأة المنتظرة تحت «إعطاء مكافأة»: اضغط «حاول مجدداً» هناك.",
} as const;

type T = Translate<typeof AR>;
/** Text kept in state, in the page's language when shown. */
type Message = Later<typeof AR>;

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
function readCardQr(text: string, cafeId: string): { token: string } | { problem: Message } {
  const fields = parseCardQr(text);
  if (fields === null) {
    return { problem: (t) => t("That QR code is not a loyalty card. Scan the card the customer shows in their wallet or browser.") };
  }
  if (fields.cafeId !== cafeId) {
    return { problem: (t) => t("That card is for another café. Ask for this café's card, or sign the customer up with the counter QR.") };
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

/** How long a recorded visit stays unsent, so the barista can undo it (owner's decision, K2). */
export const UNDO_MS = 10_000;
/** How long an open order may sit untouched before it is cleared, so the next customer's is not recorded on it (K3). */
export const ORDER_IDLE_MS = 5 * 60 * 1000;

/** A short buzz where the phone can (Android; iOS has no vibration for web pages): a scan read, a visit saved. */
function buzz(): void {
  if ("vibrate" in navigator) {
    navigator.vibrate(50);
  }
}

/** A Lebanese number in E.164 as it is read out ("+961 70 123 456"); any other number as it is. */
export function phoneShown(e164: string): string {
  if (!e164.startsWith("+961")) {
    return e164;
  }
  const local = e164.slice(4);
  const lead = local.length === 8 ? 2 : 1;
  return `+961 ${local.slice(0, lead)} ${local.slice(lead, lead + 3)} ${local.slice(lead + 3)}`;
}

/** What the server did with the last visit it settled, by its result code (K1). */
function lastVisitText(t: T, lang: Lang, last: MetaValues["lastVisit"]): string {
  const time = dateFormat(lang, { timeStyle: "short" }).format(new Date(last.occurredAt));
  switch (last.code) {
    case "STAMP_COOLDOWN":
      return t("Last visit, at {time}: recorded with no stamps, because the card got stamps less than 30 minutes before.", { time });
    case "DAILY_STAMP_CAP":
      return t("Last visit, at {time}: recorded with no stamps, because this phone reached its stamps for today. Tell the owner.", { time });
    case "CARD_GONE":
      return t("Last visit, at {time}: recorded with no stamps, because the card was deleted.", { time });
    case "HELD_FOR_REVIEW":
      return t("Last visit, at {time}: held for the owner to check; its stamps wait until the owner accepts it.", { time });
    default:
      return t("Last visit, at {time}: recorded.", { time });
  }
}

/** A reward the visit form asked the reward panel to give, and its answer, for the card it was for. */
export interface RewardNote {
  cardQr: string;
  message: RewardMessage;
}

/** The order as it was before it was recorded, put back on screen when the visit is undone. */
interface OrderDraft {
  quantities: Record<string, number>;
  names: Record<string, { nameAr: string; nameEn: string }>;
  scanned: string | null;
  phone: string;
  applyWinBack: boolean;
}

/** What the form last said: `saved` (the success style), and `undo` while the visit it saved can still be taken back. */
interface VisitNotice {
  say: Message;
  saved: boolean;
  undo?: { sequence: number; holdUntil: number; draft: OrderDraft };
}

interface VisitFormProps {
  device: DeviceRecord;
  barista: StaffEntry;
  catalog: DeviceCatalog;
  /** Whether the phone is online, which says whether a saved visit is sent now or later. */
  online: boolean;
  scanner: ScanPurpose | null;
  onScanner: (purpose: ScanPurpose | null) => void;
  onBusy: (busy: boolean) => void;
  /** Whether an order is open, for Switch barista to ask first (K11). */
  onOrderOpen: (open: boolean) => void;
  /** The server's answer to the last visit it settled, if any (K1). */
  lastVisit: MetaValues["lastVisit"] | undefined;
  /** Gives the reward for a card already scanned (K6), through the reward panel; its answer comes back as `rewardNote`. */
  onRedeem: (cardQr: string) => void;
  rewardNote: RewardNote | null;
}

/** Records a visit offline: what was ordered and whose card, by QR or phone number (AC 22, 30, 32). */
function VisitForm({ device, barista, catalog, online, scanner, onScanner, onBusy, onOrderOpen, lastVisit, onRedeem, rewardNote }: VisitFormProps) {
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
  const [problem, setProblem] = useState<{ say: Message; phone: boolean } | null>(null);
  const [notice, setNotice] = useState<VisitNotice | null>(null);
  const [saving, setSaving] = useState(false);
  /** The scanned card whose reward the server says is ready (K6); shown only while that card is the one scanned. */
  const [rewardReady, setRewardReady] = useState<string | null>(null);
  const phoneId = useId();
  const problemId = useId();
  const phoneShownId = useId();
  const scanButton = useRef<HTMLButtonElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const actionBar = useRef<HTMLDivElement>(null);

  // On a phone the action bar stays at the bottom of the screen and grows with what it says: the page keeps a control
  // the keyboard reaches clear of it by its height now (styles.css, scroll-padding).
  useEffect(() => {
    const bar = actionBar.current;
    if (bar === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const root = document.documentElement;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--action-bar-block-size", `${String(bar.getBoundingClientRect().height)}px`);
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--action-bar-block-size");
    };
  }, [scanner]);
  /** The connection now, read when a save completes: the phone may go offline while it is saved. */
  const onlineNow = useRef(online);
  useEffect(() => {
    onlineNow.current = online;
  }, [online]);
  /** The card scanned now, read when the reward check answers: the barista may have cleared or changed it meanwhile. */
  const scannedNow = useRef(scanned);
  useEffect(() => {
    scannedNow.current = scanned;
  }, [scanned]);
  /** Counts card scans: a check's answer counts only for its own scan, not an earlier scan of the same card. */
  const scanTurn = useRef(0);

  const clearOrder = () => {
    setQuantities({});
    setScanned(null);
    setPhone("");
    setApplyWinBack(false);
    setRewardReady(null);
  };

  // Undo lasts as long as the visit is held unsent; then the button goes, and the keyboard moves off it to Scan card.
  const undo = notice?.undo;
  useEffect(() => {
    if (undo === undefined) {
      return;
    }
    const timer = setTimeout(
      () => {
        if (document.activeElement === undoButton.current) {
          requestAnimationFrame(() => scanButton.current?.focus());
        }
        setNotice((current) => (current?.undo === undo ? { say: current.say, saved: current.saved } : current));
      },
      Math.max(undo.holdUntil - Date.now(), 0),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [undo]);

  const takeBack = () => {
    if (undo === undefined) {
      return;
    }
    unqueue(undo.sequence).then(
      (taken) => {
        if (taken) {
          // Back on screen as it was recorded, to fix and record again.
          setQuantities(undo.draft.quantities);
          setNames(undo.draft.names);
          setScanned(undo.draft.scanned);
          setPhone(undo.draft.phone);
          setApplyWinBack(undo.draft.applyWinBack);
          setNotice({ say: (say) => say("Visit undone. Change the order and record it again."), saved: false });
        } else {
          // Its hold has ended: sent already, or sent at the next sync.
          setNotice({ say: (say) => say("Too late to undo: the visit is sent or on its way. Tell the owner, who can fix it in Review."), saved: false });
        }
        requestAnimationFrame(() => recordButton.current?.focus());
      },
      (caught: unknown) => {
        console.error("Undoing the visit failed", caught);
        setNotice({ say: (say) => say("The visit could not be undone on this phone. Tell the owner, who can fix it in Review."), saved: false });
        requestAnimationFrame(() => recordButton.current?.focus());
      },
    );
  };

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
  const ordering = items.length > 0 || scanned !== null || phone !== "";
  useEffect(() => {
    onOrderOpen(ordering);
  }, [ordering, onOrderOpen]);

  // An order left untouched is cleared, with a notice, so the next customer's is not recorded on the last one's card.
  // Only a change to the order counts as touching it (its items, card or number), not using the rest of the counter.
  useEffect(() => {
    if (!ordering || saving) {
      return;
    }
    const timer = setTimeout(() => {
      setQuantities({});
      setScanned(null);
      setPhone("");
      setApplyWinBack(false);
      setRewardReady(null);
      setProblem(null);
      setNotice({ say: (say) => say("The open order was cleared after 5 minutes without use."), saved: false });
    }, ORDER_IDLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [ordering, saving, quantities, scanned, phone, applyWinBack]);

  // Clamped here: the steppers stay focusable at 0 and 50 (aria-disabled), so a click there changes nothing.
  const change = (type: { id: string; nameAr: string; nameEn: string }, delta: number) => {
    setNotice(null);
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
          say: phone === "" ? (say) => say("Scan the customer's card, or enter their mobile number.") : (say) => say("Enter a Lebanese mobile number, such as 70 123 456."),
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
      setProblem({ say: items.length === 0 ? (say) => say("Add what the customer ordered first.") : (say) => say("This order is too large to record. Split it into two visits."), phone: false });
      return;
    }
    setSaving(true);
    const draft: OrderDraft = { quantities, names, scanned, phone, applyWinBack };
    recordEvent("visit.recorded", 3, barista.id, payload.data, at, UNDO_MS).then(
      (queued) => {
        setSaving(false);
        clearOrder();
        buzz();
        // The server decides the stamps (cooldown, daily cap), so the counter promises no more than the order earns.
        // Now or later, as the phone's connection is when saved; the queue sends it either way, once Undo has passed.
        const sending = onlineNow.current;
        setNotice({
          say:
            stamps > 0
              ? (say, shownIn) =>
                  sending
                    ? say("Visit saved, earning up to {stamps}. Sending it now.", { stamps: plural(shownIn, STAMPS, stamps) })
                    : say("Visit saved, earning up to {stamps}. It is sent as soon as the phone is online.", { stamps: plural(shownIn, STAMPS, stamps) })
              : (say) => (sending ? say("Visit saved. Sending it now.") : say("Visit saved. It is sent as soon as the phone is online.")),
          saved: true,
          undo: { sequence: queued.sequence, holdUntil: queued.holdUntil, draft },
        });
      },
      (caught: unknown) => {
        console.error("Recording the visit failed", caught);
        setSaving(false);
        setProblem({ say: (say) => say("The visit could not be saved on this phone. Reload the page and record it again."), phone: false });
      },
    );
  };

  const typedPhone = phone === "" ? null : normalizePhoneInput(phone);
  /** The answer to a reward given from this form, for the card scanned now. */
  const shownNote = rewardNote !== null && rewardNote.cardQr === scanned ? rewardNote : null;
  /** The reward offered for the card scanned now, by name, if its check said it is ready (K6). */
  const rewardShown =
    scanned !== null && rewardReady === scanned && catalog.program !== null
      ? nameIn(lang, { nameAr: catalog.program.rewardNameAr, nameEn: catalog.program.rewardNameEn })
      : null;

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
          onTimeout={() => {
            onScanner(null);
            setNotice({ say: (say) => say("The camera turned off after a minute without a card. Press Scan card when the customer is ready."), saved: false });
            requestAnimationFrame(() => scanButton.current?.focus());
          }}
          onScan={(text) => {
            onScanner(null);
            buzz();
            const read = readCardQr(text, device.cafe.id);
            if ("problem" in read) {
              setProblem({ say: read.problem, phone: false });
              requestAnimationFrame(() => scanButton.current?.focus());
            } else {
              const token = read.token;
              setScanned(token);
              // An offer belongs to the check of this scan, not an earlier one (the reward may have been given since).
              setRewardReady(null);
              setApplyWinBack(false);
              setPhone("");
              setProblem(null);
              setNotice(null);
              // Online, whether this card's reward is ready, to give it without a second scan (K6). Offline, or when the
              // check fails, nothing is offered: the reward panel still gives it with a scan.
              scanTurn.current += 1;
              const turn = scanTurn.current;
              if (onlineNow.current && catalog.program !== null) {
                deviceRequest("POST", "/api/device/cards/status", cardStatusSchema, { cardQr: token }).then(
                  (status) => {
                    if (status.rewardReady && scanTurn.current === turn && scannedNow.current === token) {
                      setRewardReady(token);
                    }
                  },
                  (caught: unknown) => {
                    console.warn("Checking the card's reward failed", caught);
                  },
                );
              }
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
            <li key={type.id} className={quantity === 0 ? undefined : "chosen"}>
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
                    {formatUsd(type.priceCents - offer.unitDiscountCents, "en")} ({offer.campaign === null ? t("Welcome-back offer") : nameIn(lang, offer.campaign)})
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
                {/* It covers its whole row (styles.css), so a tap anywhere on the row adds one (K9). */}
                <button
                  type="button"
                  className="more"
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
      {/*
        The order: beside the menu on a tablet, kept in view as the menu scrolls. On a phone its action bar (total, card,
        record) stays at the bottom of the screen while the menu is on it.
      */}
      <div className="order-side">
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
                    setNotice(null);
                  }}
                />{" "}
                {t("Apply the welcome-back offer: {discount}", { discount: discountText(offer.discount, t) })}
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
          {scanned !== null && rewardShown !== null ? (
            <div className="reward-ready">
              <p>{t("Reward ready: {reward}.", { reward: rewardShown })}</p>
              {/*
                Disabled while either scanner is open (the reward panel's scan would start a second redemption alongside),
                and offline, as rewards need the server, like the panel's own button.
              */}
              <button
                type="button"
                className="primary"
                disabled={scanner !== null || !online}
                onClick={() => {
                  setRewardReady(null);
                  onRedeem(scanned);
                  // This button goes; the answer is said in the action bar, by the next step.
                  requestAnimationFrame(() => recordButton.current?.focus());
                }}
              >
                {t("Give {reward} now", { reward: rewardShown })}
              </button>
            </div>
          ) : null}
          {scanned === null ? (
            <div className="field">
              {/* Above the action bar and its Scan card button, so the label stands on its own. */}
              <label htmlFor={phoneId}>{t("No card? The customer's mobile number")}</label>
              <input
                id={phoneId}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                dir="ltr"
                value={phone}
                aria-invalid={problem?.phone === true ? true : undefined}
                aria-describedby={[problem?.phone === true ? problemId : null, typedPhone === null ? null : phoneShownId].filter((id) => id !== null).join(" ") || undefined}
                onChange={(event) => {
                  setPhone(event.target.value);
                  setNotice(null);
                }}
              />
              {/* The number as it will be recorded, so a mistyped one is caught before Record (K10). */}
              {typedPhone === null ? null : (
                <p id={phoneShownId} className="hint">
                  {t("Records it for {phone}.", { phone: `⁦${phoneShown(typedPhone)}⁩` })}
                </p>
              )}
            </div>
          ) : null}
        </div>
        <div ref={actionBar} className="action-bar">
          <p aria-live="polite" className="total">
            {t("Total {total} · {stamps}", { total: formatUsd(total ?? 0, "en"), stamps: plural(lang, STAMPS, stamps) })}
          </p>
          {problem === null ? null : (
            <p id={problemId} role="alert" className="field-error">
              {problem.say(t, lang)}
            </p>
          )}
          {/* Always in the page, so what appears in them is announced; empty, they take no room. */}
          <div className="statuses">
            {/* A saved visit's notice in the success style, glanceable (K4), with its Undo while it is unsent (K2). */}
            <p role="status" className={notice?.saved === true ? "saved" : undefined}>
              {notice?.say(t, lang) ?? ""}
            </p>
            {undo === undefined ? null : (
              <button ref={undoButton} type="button" className="undo" aria-label={t("Undo the visit")} onClick={takeBack}>
                {t("Undo")}
              </button>
            )}
            {/* Said too, as the button comes and goes unannounced. */}
            <p role="status" className="hint">
              {undo === undefined ? "" : t("It can be undone for 10 seconds.")}
            </p>
            {/* The offer above, announced: focus is already on Record visit, after it. */}
            <p role="status" className="visually-hidden">
              {rewardShown === null ? "" : t("Reward ready: {reward}.", { reward: rewardShown })}
            </p>
            {shownNote?.message.problem === true ? (
              <p role="alert" className="field-error">
                {shownNote.message.say(t, lang)}
              </p>
            ) : null}
            <p role="status" className={shownNote?.message.problem === false ? "saved" : undefined}>
              {shownNote?.message.problem === false ? shownNote.message.say(t, lang) : ""}
            </p>
            <p role="status" className="hint">
              {lastVisit === undefined ? "" : lastVisitText(t, lang, lastVisit)}
            </p>
          </div>
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
                    setRewardReady(null);
                    // The button that replaces this one keeps the keyboard where it was.
                    requestAnimationFrame(() => scanButton.current?.focus());
                  }}
                >
                  {t("Clear card")}
                </button>
              </p>
            )}
          </div>
          {/* aria-disabled, not disabled: the keyboard stays on it while the visit saves. */}
          <button ref={recordButton} type="button" className="primary record" aria-disabled={saving} onClick={record}>
            {saving ? t("Saving…") : t("Record visit")}
          </button>
        </div>
      </div>
    </section>
  );
}

interface RewardMessage {
  say: Message;
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
  /** Lets the visit form give the reward for a card it scanned (K6). */
  ref: Ref<Redeemer>;
  /** The answer to a reward the visit form asked for, said there, where the barista is. */
  onRequestDone: (note: RewardNote) => void;
}

/** What the visit form can ask of the reward panel. */
interface Redeemer {
  redeem: (cardQr: string) => void;
}

/**
 * Gives a reward for a scanned card, online only (AC 31). A redemption without a confirmed answer is kept in
 * IndexedDB and must be tried again (same event id) before another can start, so a lost answer, a reload or an update
 * never gives the reward twice. The visit form can ask for one for a card it scanned: its answer is said there, and a
 * problem here too, where Try again is.
 */
function RedeemPanel({ device, barista, catalog, online, scanner, onScanner, onBusy, ref, onRequestDone }: RedeemPanelProps) {
  const t = useT(AR);
  const lang = useLang();
  const [pending, setPending] = useState<PendingReward | null>(null);
  /** `echo`: what the visit form says already, shown here but not announced a second time. */
  const [message, setMessage] = useState<(RewardMessage & { echo?: boolean }) | null>(null);
  const [sending, setSending] = useState(false);
  /** Whether the phone's storage was read for an unconfirmed reward: none can start before, so none is given twice. */
  const [checked, setChecked] = useState(false);
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
        if (current) {
          setChecked(true);
        }
        if (current && stored !== undefined) {
          setPending({ ...stored, earlier: true });
          setMessage({
            say: (say, shownIn) =>
              say("A reward started at {time} was not confirmed. Press Try again to find out whether that customer got it, before giving another.", {
                time: startedAt(shownIn, stored),
              }),
            problem: true,
          });
        }
      },
      (caught: unknown) => {
        console.error("Reading the unconfirmed reward failed", caught);
        if (current) {
          setMessage({ say: (say) => say("This phone's storage could not be read, so an unconfirmed reward may be waiting. Reload the page before giving a reward."), problem: true });
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

  /** The card of an attempt the visit form asked for, until it ends: its answer goes back there. */
  const askedFor = useRef<string | null>(null);

  /** Ends an attempt: the message, and the keyboard back on the panel's button (or left in the visit form, if asked from there). */
  const finish = (say: Message, problem: boolean) => {
    setSending(false);
    const asked = askedFor.current;
    askedFor.current = null;
    if (asked === null) {
      setMessage({ say, problem });
      setRefocus((turn) => turn + 1);
      return;
    }
    onRequestDone({ cardQr: asked, message: { say, problem } });
    // A problem stays here too, beside the Try again it may need; the visit form's alert has announced it.
    setMessage(problem ? { say, problem, echo: true } : null);
  };

  /** The server's answer, so the redemption is done with either way. */
  const settle = (answer: Message, problem: boolean) => {
    setPending(null);
    finish(answer, problem);
    deleteMeta("pendingRedemption").catch((caught: unknown) => {
      console.error("Clearing the unconfirmed reward failed", caught);
      finish(
        (say, shownIn) => say("{answer} This phone could not forget the reward, so it may offer it again after a reload: do not give it twice.", { answer: answer(say, shownIn) }),
        true,
      );
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
      finish((say) => say("The reward could not be started on this phone. Reload the page and try again."), true);
      return;
    }
    setPending(attempt);
    // One from before a reload may be for a customer who has left: the barista is told which one it was.
    try {
      const redemption = await deviceRequest("POST", "/api/device/redemptions", redemptionSchema, { eventId: attempt.eventId, staffId: barista.id, cardQr: attempt.cardQr });
      const given = (shownIn: Lang) => ({
        reward: shownIn === "ar" ? redemption.rewardNameAr : redemption.rewardNameEn,
        left: plural(shownIn, STAMPS, redemption.stampsLeft),
      });
      settle(
        attempt.earlier
          ? (say, shownIn) =>
              say("The earlier reward, started at {time}, was given: {reward}. {left} left on that card. If that customer did not get it, tell the owner.", {
                ...given(shownIn),
                time: startedAt(shownIn, attempt),
              })
          : (say, shownIn) => say("Reward given: {reward}. {left} left on the card.", given(shownIn)),
        false,
      );
    } catch (caught) {
      if (caught instanceof RequestError && caught.failure.retryable) {
        // Nothing sends it again by itself, and whether it was given is unknown until it is.
        finish((say, shownIn) => say("The reward started at {time} was not confirmed. Do not give it yet: check the connection, then press Try again.", { time: startedAt(shownIn, attempt) }), true);
      } else if (caught instanceof RequestError || caught instanceof DeviceUnpairedError) {
        const reason = caught.message;
        settle(
          attempt.earlier
            ? (say, shownIn) => say("The earlier reward, started at {time}, was not given: {reason}", { time: startedAt(shownIn, attempt), reason: localiseApiMessage(shownIn, reason) })
            : (_say, shownIn) => localiseApiMessage(shownIn, reason),
          true,
        );
      } else {
        console.error("Redeeming failed", caught);
        finish((say) => say("The reward could not be confirmed on this phone. Reload the page, then press Try again."), true);
      }
    }
  };

  useImperativeHandle(ref, () => ({
    redeem: (cardQr: string) => {
      if (!checked) {
        onRequestDone({ cardQr, message: { say: (say) => say("This phone's storage could not be read, so an unconfirmed reward may be waiting. Reload the page before giving a reward."), problem: true } });
        return;
      }
      if (pending !== null || sending) {
        onRequestDone({ cardQr, message: { say: (say) => say("Finish the reward waiting under Give a reward first: press Try again there."), problem: true } });
        return;
      }
      askedFor.current = cardQr;
      void send({ eventId: crypto.randomUUID(), cardQr, startedAt: new Date().toISOString(), earlier: false });
    },
  }));

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
          onTimeout={() => {
            onScanner(null);
            finish((say) => say("The camera turned off after a minute without a card. Press Scan card for a reward when the customer is ready."), false);
          }}
          onScan={(text) => {
            onScanner(null);
            buzz();
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
            {online ? "" : t("Rewards need an internet connection. Connect the phone, then try again.")}
          </p>
          {pending === null ? (
            <button
              ref={actionButton}
              type="button"
              disabled={!online || sending || scanner !== null || !checked}
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
        <p role={message.echo === true ? undefined : "alert"} className="field-error">
          {message.say(t, lang)}
        </p>
      ) : null}
      {/* Always in the page, so the confirmation is announced. */}
      <p role="status">{message?.problem === false ? message.say(t, lang) : ""}</p>
    </section>
  );
}

const noop = () => undefined;

/**
 * The barista's counter: recording visits, and rewards when online. The camera serves one of them at a time. The screen
 * is kept awake while it shows.
 */
export function CounterScreen({
  device,
  barista,
  catalog,
  online,
  onBusy,
  onOrderOpen = noop,
  lastVisit,
}: {
  device: DeviceRecord;
  barista: StaffEntry;
  catalog: DeviceCatalog | undefined;
  online: boolean;
  onBusy: (busy: boolean) => void;
  onOrderOpen?: (open: boolean) => void;
  lastVisit?: MetaValues["lastVisit"] | undefined;
}) {
  const t = useT(AR);
  const [scanner, setScanner] = useState<ScanPurpose | null>(null);
  const [visitBusy, setVisitBusy] = useState(false);
  const [rewardBusy, setRewardBusy] = useState(false);
  const redeemer = useRef<Redeemer>(null);
  const [rewardNote, setRewardNote] = useState<RewardNote | null>(null);

  // The screen stays on between customers (K13), where the browser allows it; asked again when the page shows again,
  // as the browser lets it go when the page is hidden.
  useEffect(() => {
    if (!("wakeLock" in navigator)) {
      return;
    }
    let lock: WakeLockSentinel | null = null;
    let active = true;
    const keepAwake = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      navigator.wakeLock.request("screen").then(
        (sentinel) => {
          if (active) {
            // Two requests may both resolve (one pending across the page hiding and showing): keep only the latest.
            void lock?.release();
            lock = sentinel;
          } else {
            void sentinel.release();
          }
        },
        (caught: unknown) => {
          // Refused (battery saver, a hidden page): the phone just sleeps as it would anyway.
          console.warn("Keeping the screen on failed", caught);
        },
      );
    };
    keepAwake();
    document.addEventListener("visibilitychange", keepAwake);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", keepAwake);
      void lock?.release();
    };
  }, []);
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
      <VisitForm
        device={device}
        barista={barista}
        catalog={catalog}
        online={online}
        scanner={scanner}
        onScanner={setScanner}
        onBusy={setVisitBusy}
        onOrderOpen={onOrderOpen}
        lastVisit={lastVisit}
        rewardNote={rewardNote}
        onRedeem={(cardQr) => {
          setRewardNote(null);
          redeemer.current?.redeem(cardQr);
        }}
      />
      <RedeemPanel
        device={device}
        barista={barista}
        catalog={catalog}
        online={online}
        scanner={scanner}
        onScanner={setScanner}
        onBusy={setRewardBusy}
        ref={redeemer}
        onRequestDone={setRewardNote}
      />
    </div>
  );
}
