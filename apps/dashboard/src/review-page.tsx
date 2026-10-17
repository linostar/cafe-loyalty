import { reviewDecisionSchema, reviewQueueSchema, type ReviewItem, type SyncHoldReason } from "@cafe-loyalty/shared";
import { useContext, useEffect, useRef, useState } from "react";
import { apiRequest, isStale } from "./api.js";
import { ConfirmButton, FormError, Notice, useSubmit } from "./forms.js";
import { dateFormat, useLang, useT, type Translate } from "./i18n.js";
import { AttentionContext, PageStatus, useApiData } from "./session.js";

const AR = {
  Visit: "زيارة",
  "PIN lockout report": "تقرير قفل الرمز السري",
  "from a phone you removed": "من هاتف أزلته",
  "by a barista you removed": "من باريستا أزلته",
  "that reached the server more than two days later": "وصل إلى الخادم بعد أكثر من يومين",
  "with a discount its campaign or the card's win-back offer did not allow at that time (ended, outside its hours, already used, or below your margin)":
    "بخصم لم تسمح به حملته أو عرض الاسترجاع على البطاقة في ذلك الوقت (منتهٍ، أو خارج ساعاته، أو مستخدم من قبل، أو دون هامشك)",
  "with more stamps than the reward needs": "بأختام أكثر مما تحتاجه المكافأة",
  "that would take that phone past its most stamps for the day the server received it":
    "كانت ستتجاوز بذلك الهاتف الحد الأقصى من الأختام لليوم الذي استلمها فيه الخادم",
  "dated before that phone was paired with the key that signed it": "بتاريخ يسبق ربط ذلك الهاتف بالمفتاح الذي وقّعها",
  "the card got stamps less than 30 minutes before it": "حصلت البطاقة على أختام قبلها بأقل من 30 دقيقة",
  "that phone had already added its most stamps for that day": "كان ذلك الهاتف قد أضاف الحد الأقصى من الأختام لذلك اليوم",
  "the customer deleted the card": "حذف الزبون البطاقة",
  "the server answered {code}": "أجاب الخادم {code}",
  "Accepted: {what}.": "مقبول: {what}.",
  "Discarded: {what}.": "مُهمل: {what}.",
  "{done} It counts as a visit, but the card got no stamps: {why}.": "{done} تُحتسب زيارةً، لكن البطاقة لم تحصل على أختام: {why}.",
  "{type} by {staff} on {device} at {time}": "{type} من {staff} على {device} في {time}",
  "at {time} {reason}: {staff} on {device}.": "في {time} {reason}: {staff} على {device}.",
  "It also has a discount its campaign or the card's win-back offer did not allow at that time (ended, outside its hours, already used, or below your margin).":
    "وفيه أيضاً خصم لم تسمح به حملته أو عرض الاسترجاع على البطاقة في ذلك الوقت (منتهٍ، أو خارج ساعاته، أو مستخدم من قبل، أو دون هامشك).",
  Accept: "قبول",
  "Yes, accept": "نعم، اقبل",
  Discard: "إهمال",
  "Yes, discard": "نعم، أهمل",
  "Accept {what}": "قبول {what}",
  "Yes, accept {what}": "نعم، اقبل {what}",
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
  campaign_check: "with a discount its campaign or the card's win-back offer did not allow at that time (ended, outside its hours, already used, or below your margin)",
  large_visit: "with more stamps than the reward needs",
  daily_cap_received: "that would take that phone past its most stamps for the day the server received it",
  before_key: "dated before that phone was paired with the key that signed it",
} as const satisfies Readonly<Record<SyncHoldReason, keyof typeof AR>>;

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

function ReviewEntry({ item, pending, onDecide }: { item: ReviewItem; pending: boolean; onDecide: (decision: "accept" | "discard") => void }) {
  const t = useT(AR);
  const timeFormat = dateFormat(useLang(), TIME_OPTIONS);
  const what = describe(t, timeFormat, item);
  return (
    <li tabIndex={-1} data-review-id={item.id} className="review-item">
      <strong>{typeLabel(t, item)}</strong>{" "}
      {t("at {time} {reason}: {staff} on {device}.", {
        time: timeFormat.format(new Date(item.occurredAt)),
        reason: t(REASONS[item.reason]),
        staff: item.staffName,
        device: item.deviceName,
      })}
      {item.discountRefused && item.reason !== "campaign_check" ? (
        <>
          {" "}
          {t(
            "It also has a discount its campaign or the card's win-back offer did not allow at that time (ended, outside its hours, already used, or below your margin).",
          )}
        </>
      ) : null}
      <div className="actions">
        {/* Short visible labels; each name adds the item, so it is the button's own (WCAG 2.5.3: it starts with what is shown). */}
        <ConfirmButton
          label={t("Accept")}
          confirmLabel={t("Yes, accept")}
          name={t("Accept {what}", { what })}
          confirmName={t("Yes, accept {what}", { what })}
          pending={pending}
          onConfirm={() => {
            onDecide("accept");
          }}
        />
        <ConfirmButton
          label={t("Discard")}
          confirmLabel={t("Yes, discard")}
          name={t("Discard {what}", { what })}
          confirmName={t("Yes, discard {what}", { what })}
          pending={pending}
          onConfirm={() => {
            onDecide("discard");
          }}
        />
      </div>
    </li>
  );
}

/** `/review`: what removed phones and baristas recorded, held until the owner accepts or discards it (AC 21). */
export function ReviewPage() {
  const t = useT(AR);
  const lang = useLang();
  const [reload, setReload] = useState(0);
  const [state] = useApiData("/api/review-queue", reviewQueueSchema, reload);
  const attention = useContext(AttentionContext);
  /** Every item loaded so far (the first page, then each "Show more"), less the ones decided here. */
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The first item of the page just loaded, to take focus once it is shown. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const { pending, error, submit } = useSubmit();

  useEffect(() => {
    if (focusId !== null) {
      list.current?.querySelector<HTMLElement>(`[data-review-id="${focusId}"]`)?.focus();
    }
  }, [focusId]);

  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const shown = items ?? state.data.items;
  const cursor = items === null ? state.data.nextCursor : nextCursor;
  const startOver = () => {
    setItems(null);
    setReload((value) => value + 1);
  };

  return (
    <section aria-labelledby="review-page-title">
      <h2 id="review-page-title" tabIndex={-1} data-focus-after-change>
        {t("Review")}
      </h2>
      <p className="page-intro">
        {t("Visits held for you to check. An accepted visit counts, with its stamps if the card can still get them; a discarded one counts for nothing.")}
      </p>
      {notice === null ? null : <Notice>{notice}</Notice>}
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
              onDecide={(decision) => {
                setNotice(null);
                void submit(() => apiRequest("POST", `/api/review-queue/${item.id}/${decision}`, reviewDecisionSchema)).then((result) => {
                  if (result.ok) {
                    // Taken off the list in place, so the owner keeps every page already loaded.
                    setItems(shown.filter((entry) => entry.id !== item.id));
                    setNextCursor(cursor);
                    setNotice(decided(t, dateFormat(lang, TIME_OPTIONS), decision, item, result.value.outcome));
                    // The navigation's count, too.
                    attention.reload();
                  } else if (isStale(result.error)) {
                    startOver();
                  }
                });
              }}
            />
          ))}
        </ul>
      )}
      {cursor === null ? null : (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            void submit(() => apiRequest("GET", `/api/review-queue?cursor=${encodeURIComponent(cursor)}`, reviewQueueSchema)).then((result) => {
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
