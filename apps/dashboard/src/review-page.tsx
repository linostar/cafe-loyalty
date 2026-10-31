import { formatUsd, plural, reviewDecisionSchema, reviewQueueSchema, type Lang, type ReviewItem, type SyncHoldReason } from "@cafe-loyalty/shared";
import { useContext, useEffect, useRef, useState } from "react";
import { apiRequest, isStale } from "./api.js";
import { ConfirmButton, FormError, Notice, useSubmit } from "./forms.js";
import { dateFormat, useLang, useT, type Later, type Translate } from "./i18n.js";
import { AttentionContext, PageStatus, useApiData } from "./session.js";

const AR = {
  Visit: "زيارة",
  "PIN lockout report": "تقرير قفل الرمز السري",
  "from a phone you removed": "من هاتف أزلته",
  "by a barista you removed": "من باريستا أزلته",
  "that reached the server more than two days later": "وصل إلى الخادم بعد أكثر من يومين",
  "with a discount its campaign or the card's welcome-back offer did not allow at that time (ended, outside its hours, already used, or below your margin)":
    "بخصم لم تسمح به حملته أو عرض العودة على البطاقة في ذلك الوقت (منتهٍ، أو خارج ساعاته، أو مستخدم من قبل، أو دون هامشك)",
  "with more stamps than the reward needs": "بأختام أكثر مما تحتاجه المكافأة",
  "that would take that phone past its most stamps for the day the server received it":
    "كانت ستتجاوز بذلك الهاتف الحد الأقصى من الأختام لليوم الذي استلمها فيه الخادم",
  "dated before that phone was paired with the key that signed it": "بتاريخ يسبق ربط ذلك الهاتف بالمفتاح الذي وقّعها",
  "for a reason this page does not know yet (reload it)": "لسبب لا تعرفه هذه الصفحة بعد (أعد تحميلها)",
  "the card got stamps less than 30 minutes before it": "حصلت البطاقة على أختام قبلها بأقل من 30 دقيقة",
  "that phone had already added its most stamps for that day": "كان ذلك الهاتف قد أضاف الحد الأقصى من الأختام لذلك اليوم",
  "the customer deleted the card": "حذف الزبون البطاقة",
  "the server answered {code}": "أجاب الخادم {code}",
  "Accepted: {what}.": "مقبول: {what}.",
  "Discarded: {what}.": "مُهمل: {what}.",
  "{done} It counts as a visit, but the card got no stamps: {why}.": "{done} تُحتسب زيارةً، لكن البطاقة لم تحصل على أختام: {why}.",
  "{type} by {staff} on {device} at {time}": "{type} من {staff} على {device} في {time}",
  "at {time} {reason}: {staff} on {device}.": "في {time} {reason}: {staff} على {device}.",
  "It also has a discount its campaign or the card's welcome-back offer did not allow at that time (ended, outside its hours, already used, or below your margin).":
    "وفيه أيضاً خصم لم تسمح به حملته أو عرض العودة على البطاقة في ذلك الوقت (منتهٍ، أو خارج ساعاته، أو مستخدم من قبل، أو دون هامشك).",
  "Order: {items}. Total {total}, for {stamps}.": "الطلب: {items}. المجموع {total}، مقابل {stamps}.",
  "{quantity} × {name}": "{quantity} × {name}",
  Accept: "قبول",
  Discard: "إهمال",
  "Yes, discard": "نعم، أهمل",
  "Accept {what}": "قبول {what}",
  "Accepted in 10 seconds unless you undo it.": "يُقبل بعد 10 ثوانٍ ما لم تتراجع عنه.",
  Undo: "تراجع",
  "Undo within 10 seconds: accepting {what}": "تراجع خلال 10 ثوانٍ: قبول {what}",
  "Not accepted: {what}.": "لم يُقبل: {what}.",
  "Discard {what}": "إهمال {what}",
  "Yes, discard {what}": "نعم، أهمل {what}",
  Review: "المراجعة",
  "Visits held for you to check. An accepted visit counts, with its stamps if the card can still get them; a discarded one counts for nothing.":
    "زيارات محجوزة لتتحقق منها. الزيارة المقبولة تُحتسب، مع أختامها إن كانت البطاقة لا تزال تقبلها، والمُهملة لا تُحتسب.",
  "Nothing to review. What removed phones or baristas send, and visits held at sync, wait here for you.":
    "لا شيء للمراجعة. ما ترسله الهواتف أو الباريستا الذين أُزيلوا، والزيارات المحتجزة عند المزامنة، ينتظرك هنا.",
  "Show more": "عرض المزيد",
} as const;

type T = Translate<typeof AR>;

const TYPE_LABELS: Readonly<Record<string, "Visit" | "PIN lockout report">> = { "visit.recorded": "Visit", "staff.pin_lockout": "PIN lockout report" };

const REASONS = {
  device_revoked: "from a phone you removed",
  staff_revoked: "by a barista you removed",
  late_sync: "that reached the server more than two days later",
  campaign_check: "with a discount its campaign or the card's welcome-back offer did not allow at that time (ended, outside its hours, already used, or below your margin)",
  large_visit: "with more stamps than the reward needs",
  daily_cap_received: "that would take that phone past its most stamps for the day the server received it",
  before_key: "dated before that phone was paired with the key that signed it",
} as const satisfies Readonly<Record<SyncHoldReason, keyof typeof AR>>;

/** A reason this build does not know (from a newer server: after a rollback, or in a page opened before a deploy). */
const reasonText = (reason: string): keyof typeof AR =>
  Object.hasOwn(REASONS, reason) ? REASONS[reason as SyncHoldReason] : "for a reason this page does not know yet (reload it)";

/** Why an accepted visit still added no stamps, by its result code. */
const NO_STAMPS: Readonly<Record<string, keyof typeof AR>> = {
  STAMP_COOLDOWN: "the card got stamps less than 30 minutes before it",
  DAILY_STAMP_CAP: "that phone had already added its most stamps for that day",
  CARD_GONE: "the customer deleted the card",
};

/** The confirmation after a decision; an accepted visit that added no stamps says why (`outcome` is its result code). */
function decided(t: T, timeFormat: Intl.DateTimeFormat, decision: "accept" | "discard", item: ReviewItem, outcome: string | null): string {
  const what = describe(t, timeFormat, item);
  const done = decision === "accept" ? t("Accepted: {what}.", { what }) : t("Discarded: {what}.", { what });
  if (outcome === null || outcome === "OK") {
    return done;
  }
  const reason = NO_STAMPS[outcome];
  return t("{done} It counts as a visit, but the card got no stamps: {why}.", {
    done,
    why: reason === undefined ? t("the server answered {code}", { code: outcome }) : t(reason),
  });
}

const typeLabel = (t: T, item: ReviewItem): string => {
  const label = TYPE_LABELS[item.type];
  return label === undefined ? item.type : t(label);
};

/** What an item is, for its buttons and for the confirmation after a decision. */
function describe(t: T, timeFormat: Intl.DateTimeFormat, item: ReviewItem): string {
  return t("{type} by {staff} on {device} at {time}", {
    type: typeLabel(t, item),
    staff: item.staffName,
    device: item.deviceName,
    time: timeFormat.format(new Date(item.occurredAt)),
  });
}

// To the second, so two items from the same phone and barista still get different button names.
const TIME_OPTIONS = { dateStyle: "medium", timeStyle: "medium" } as const;

/** How long an Accept waits, with Undo, before it is sent: the server's accept is final. */
export const ACCEPT_DELAY_MS = 10_000;

const STAMPS = {
  en: { one: "{n} stamp", other: "{n} stamps" },
  ar: { zero: "بلا أختام", one: "ختم واحد", two: "ختمان", few: "{n} أختام", many: "{n} ختماً", other: "{n} ختم" },
};

/**
 * Sends an accept not sent yet as the page goes, with keepalive, so the browser finishes it after the page has gone. No
 * code runs after that to say a failure: an accept that did not go through leaves the item held, still counted in the
 * navigation's Review count and Home's Needs you, and listed here on the next visit.
 */
function sendOnLeaving(id: string) {
  void fetch(`/api/review-queue/${id}/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", keepalive: true }).catch(() => undefined);
}

function ReviewEntry({
  item,
  pending,
  waiting,
  onAccept,
  onUndo,
  onDiscard,
}: {
  item: ReviewItem;
  pending: boolean;
  /** Accepted, and waiting to be sent: Undo still takes it back. */
  waiting: boolean;
  onAccept: () => void;
  onUndo: () => void;
  onDiscard: () => void;
}) {
  const t = useT(AR);
  const lang = useLang();
  const timeFormat = dateFormat(lang, TIME_OPTIONS);
  const what = describe(t, timeFormat, item);
  const actions = useRef<HTMLDivElement>(null);
  /** Set by Accept and Undo, so focus goes to the button that replaced the one pressed (Undo, Accept); not when the wait ends. */
  const focusNext = useRef(false);
  useEffect(() => {
    if (focusNext.current) {
      focusNext.current = false;
      actions.current?.querySelector("button")?.focus();
    }
  }, [waiting]);
  return (
    <li tabIndex={-1} data-review-id={item.id} className="review-item">
      <strong>{typeLabel(t, item)}</strong>{" "}
      {t("at {time} {reason}: {staff} on {device}.", {
        time: timeFormat.format(new Date(item.occurredAt)),
        reason: t(reasonText(item.reason)),
        staff: item.staffName,
        device: item.deviceName,
      })}
      {item.discountRefused && item.reason !== "campaign_check" ? (
        <>
          {" "}
          {t(
            "It also has a discount its campaign or the card's welcome-back offer did not allow at that time (ended, outside its hours, already used, or below your margin).",
          )}
        </>
      ) : null}
      {item.visit === null ? null : (
        <p>
          {t("Order: {items}. Total {total}, for {stamps}.", {
            items: new Intl.ListFormat(lang, { type: "unit" }).format(
              item.visit.items.map((line) => t("{quantity} × {name}", { quantity: line.quantity, name: lang === "ar" ? line.nameAr : line.nameEn })),
            ),
            total: formatUsd(item.visit.totalCents, "en"),
            stamps: plural(lang, STAMPS, item.visit.stamps),
          })}
        </p>
      )}
      {waiting ? <p className="hint">{t("Accepted in 10 seconds unless you undo it.")}</p> : null}
      <div className="actions" ref={actions}>
        {/* Short visible labels; each name adds the item, so it is the button's own (WCAG 2.5.3: it starts with what is shown). */}
        {waiting ? (
          <button
            type="button"
            aria-label={t("Undo within 10 seconds: accepting {what}", { what })}
            onClick={() => {
              focusNext.current = true;
              onUndo();
            }}
          >
            {t("Undo")}
          </button>
        ) : (
          <>
            {/* One tap: the accept waits, with Undo, before it is sent. */}
            <button
              type="button"
              aria-label={t("Accept {what}", { what })}
              aria-disabled={pending || undefined}
              onClick={() => {
                if (!pending) {
                  focusNext.current = true;
                  onAccept();
                }
              }}
            >
              {t("Accept")}
            </button>
            <ConfirmButton
              label={t("Discard")}
              confirmLabel={t("Yes, discard")}
              name={t("Discard {what}", { what })}
              confirmName={t("Yes, discard {what}", { what })}
              pending={pending}
              onConfirm={onDiscard}
            />
          </>
        )}
      </div>
    </li>
  );
}

/** `/review`: what removed phones and baristas recorded, held until the owner accepts or discards it (AC 21). */
export function ReviewPage() {
  const t = useT(AR);
  const lang = useLang();
  const [reload, setReload] = useState(0);
  const [state, , retry] = useApiData("/api/review-queue", reviewQueueSchema, reload);
  const attention = useContext(AttentionContext);
  /** Every item loaded so far (the first page, then each "Show more"), less the ones decided here. */
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  /** Kept by id, so a decision sent after its wait leaves out its item from whatever list is shown by then. */
  const [decidedIds, setDecidedIds] = useState<ReadonlySet<string>>(new Set());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** Built when shown, so it follows a language switch. */
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  /** The first item of the page just loaded, to take focus once it is shown. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const { pending, error, submit } = useSubmit();
  /** Accepted items waiting to be sent (ACCEPT_DELAY_MS). */
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  /**
   * Every accept not sent yet, by id: its timer while it waits, null once the wait is over and it is queued behind
   * another request. Taken out as its request starts (sent with keepalive, so leaving never drops it) or as it is
   * sent on leaving, so none is sent twice.
   */
  const unsent = useRef(new Map<string, number | null>());
  /** Requests one after another: an accept whose wait ends while another request is on its way is sent next, not dropped. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (focusId !== null) {
      list.current?.querySelector<HTMLElement>(`[data-review-id="${focusId}"]`)?.focus();
    }
  }, [focusId]);

  // An accept not sent yet when the owner leaves (another page, a closed tab), waiting or queued, is sent then; one
  // already on its way was sent with keepalive.
  useEffect(() => {
    const accepts = unsent.current;
    const sendWaiting = () => {
      for (const [id, timer] of accepts) {
        window.clearTimeout(timer ?? undefined);
        sendOnLeaving(id);
      }
      accepts.clear();
    };
    const onPageHide = () => {
      sendWaiting();
      setWaiting(new Set());
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      sendWaiting();
    };
  }, []);

  // A page brought back from the back-forward cache loads the queue and the counts again: what was sent as it left may
  // be decided by now.
  const reloadAttention = attention.reload;
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setNotice(null);
        setItems(null);
        setReload((value) => value + 1);
        reloadAttention();
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [reloadAttention]);

  if (state.status !== "loaded") {
    return <PageStatus state={state} onRetry={retry} />;
  }
  const shown = (items ?? state.data.items).filter((entry) => !decidedIds.has(entry.id));
  const cursor = items === null ? state.data.nextCursor : nextCursor;
  const startOver = () => {
    setItems(null);
    setReload((value) => value + 1);
  };
  const inTurn = (request: () => Promise<void>) => {
    queue.current = queue.current.then(request);
  };
  const decide = (item: ReviewItem, decision: "accept" | "discard") => {
    inTurn(async () => {
      // An accept sent on leaving while it was queued is not sent again.
      if (decision === "accept" && !unsent.current.delete(item.id)) {
        return;
      }
      setNotice(null);
      const result = await submit(() => apiRequest("POST", `/api/review-queue/${item.id}/${decision}`, reviewDecisionSchema, {}, { keepalive: decision === "accept" }));
      if (result.ok) {
        // Taken off the list in place, so the owner keeps every page already loaded.
        setDecidedIds((current) => new Set(current).add(item.id));
        const { outcome } = result.value;
        setNotice(() => (say: T, shownIn: Lang) => decided(say, dateFormat(shownIn, TIME_OPTIONS), decision, item, outcome));
        // The navigation's count, too.
        attention.reload();
      } else if (isStale(result.error)) {
        startOver();
      }
    });
  };
  const stopWaiting = (id: string) => {
    setWaiting((current) => new Set([...current].filter((entry) => entry !== id)));
  };
  const accept = (item: ReviewItem) => {
    setWaiting((current) => new Set(current).add(item.id));
    unsent.current.set(
      item.id,
      window.setTimeout(() => {
        // Focus on the item's Undo goes to the heading, which stays as the item goes.
        if (list.current?.querySelector(`[data-review-id="${item.id}"]`)?.contains(document.activeElement) === true) {
          document.getElementById("review-page-title")?.focus();
        }
        unsent.current.set(item.id, null);
        stopWaiting(item.id);
        decide(item, "accept");
      }, ACCEPT_DELAY_MS),
    );
    // Focus goes to Undo, whose name says it first, with the 10 seconds; the status does not repeat it.
    setNotice(null);
  };
  const undo = (item: ReviewItem) => {
    window.clearTimeout(unsent.current.get(item.id) ?? undefined);
    unsent.current.delete(item.id);
    stopWaiting(item.id);
    setNotice(() => (say: T, shownIn: Lang) => say("Not accepted: {what}.", { what: describe(say, dateFormat(shownIn, TIME_OPTIONS), item) }));
  };

  return (
    <section aria-labelledby="review-page-title">
      <h2 id="review-page-title" tabIndex={-1} data-focus-after-change>
        {t("Review")}
      </h2>
      <p className="page-intro">
        {t("Visits held for you to check. An accepted visit counts, with its stamps if the card can still get them; a discarded one counts for nothing.")}
      </p>
      <Notice>{notice?.(t, lang)}</Notice>
      <FormError message={error} />
      {shown.length === 0 ? (
        <p className="empty">{t("Nothing to review. What removed phones or baristas send, and visits held at sync, wait here for you.")}</p>
      ) : (
        <ul className="items" ref={list}>
          {shown.map((item) => (
            <ReviewEntry
              key={item.id}
              item={item}
              pending={pending}
              waiting={waiting.has(item.id)}
              onAccept={() => {
                accept(item);
              }}
              onUndo={() => {
                undo(item);
              }}
              onDiscard={() => {
                decide(item, "discard");
              }}
            />
          ))}
        </ul>
      )}
      {cursor === null ? null : (
        <button
          type="button"
          aria-disabled={pending || undefined}
          onClick={() => {
            if (pending) {
              return;
            }
            inTurn(async () => {
              const result = await submit(() => apiRequest("GET", `/api/review-queue?cursor=${encodeURIComponent(cursor)}`, reviewQueueSchema));
              if (result.ok) {
                const known = new Set(shown.map((entry) => entry.id));
                const added = result.value.items.filter((entry) => !known.has(entry.id));
                setItems([...shown, ...added]);
                setNextCursor(result.value.nextCursor);
                // Focus moves to what was loaded, and stays on the page when this button goes.
                if (added[0] === undefined) {
                  document.getElementById("review-page-title")?.focus();
                } else {
                  setFocusId(added[0].id);
                }
              }
            });
          }}
        >
          {t("Show more")}
        </button>
      )}
    </section>
  );
}
