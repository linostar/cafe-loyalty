import { feedbackInboxSchema, feedbackReadSchema, plural, type FeedbackItem, type Lang } from "@cafe-loyalty/shared";
import { apiRequest } from "./api.js";
import { useContext, useEffect, useRef, useState } from "react";
import { FormError, Notice, useSubmit } from "./forms.js";
import { dateFormat, useLang, useT, type Later, type Translate } from "./i18n.js";
import { AttentionContext, PageStatus, useApiData } from "./session.js";

const AR = {
  New: "جديدة",
  "Received {received}, about a visit in the hour from {hour}": "وصلت {received}، عن زيارة في الساعة التي تبدأ {hour}",
  "Mark as read": "تعليم كمقروءة",
  "Mark as read: the message of {received}": "تعليم كمقروءة: رسالة {received}",
  Inbox: "الوارد",
  "About two hours after a visit, the customer's card links to a page where they can send you a private message, and every customer is offered your Google review link there too. Messages carry no name or number, so you cannot reply here.":
    "بعد نحو ساعتين من الزيارة، تربط بطاقة الزبون بصفحة يمكنه فيها إرسال رسالة خاصة إليك، ويُعرض هناك أيضاً على كل زبون رابط تقييمك على Google. لا تحمل الرسائل اسماً ولا رقماً، لذا لا يمكنك الرد هنا.",
  "No unread messages.": "لا رسائل غير مقروءة.",
  "No messages yet. What customers write about their visits arrives here.": "لا رسائل بعد. ما يكتبه الزبائن عن زياراتهم يصل إلى هنا.",
  "The message of {received} is marked as read.": "عُلّمت رسالة {received} كمقروءة.",
  "Show older messages": "عرض الرسائل الأقدم",
} as const;

const UNREAD = {
  en: { one: "{n} unread message.", other: "{n} unread messages." },
  ar: { one: "رسالة واحدة غير مقروءة.", two: "رسالتان غير مقروءتين.", few: "{n} رسائل غير مقروءة.", other: "{n} رسالة غير مقروءة." },
};
// To the second, so two messages received in the same minute still get different button names.
const TIME_OPTIONS = { dateStyle: "medium", timeStyle: "medium" } as const;
// The customer's own words, in the language they wrote them: Arabic (the feedback page's default) reads right to left.
const ARABIC_FIRST = /^\P{L}*\p{Script=Arabic}/u;

function Message({ item, pending, onRead }: { item: FeedbackItem; pending: boolean; onRead: () => void }) {
  const t = useT(AR);
  const lang = useLang();
  const received = dateFormat(lang, TIME_OPTIONS).format(new Date(item.receivedAt));
  return (
    <li tabIndex={-1} data-feedback-id={item.id} className="feedback-item">
      <p className="feedback-meta">
        {item.read ? null : (
          <>
            <span className="badge badge-accent">{t("New")}</span>{" "}
          </>
        )}
        {t("Received {received}, about a visit in the hour from {hour}", {
          received,
          hour: dateFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.visitedAt)),
        })}
      </p>
      <p className="feedback-message" dir="auto" lang={ARABIC_FIRST.test(item.message) ? "ar" : undefined}>
        {item.message}
      </p>
      {item.read ? null : (
        <div className="actions">
          {/* A short visible label; the name adds the message, so it is the button's own (WCAG 2.5.3: it starts with what is shown). */}
          <button type="button" aria-label={t("Mark as read: the message of {received}", { received })} aria-disabled={pending || undefined} onClick={onRead}>
            {t("Mark as read")}
          </button>
        </div>
      )}
    </li>
  );
}

/** `/inbox`: customers' private feedback about their visits (AC 37), newest first, a page at a time. */
export function InboxPage() {
  const t = useT(AR);
  const lang = useLang();
  const [state, setData, retry] = useApiData("/api/feedback", feedbackInboxSchema);
  const attention = useContext(AttentionContext);
  const { pending, error, submit } = useSubmit();
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  /** The message to take focus once shown: the next unread after one is read, or the first of an older page. */
  // An object, so focusing the same message again still runs the effect.
  const [focusOn, setFocusOn] = useState<{ id: string } | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (focusOn !== null) {
      list.current?.querySelector<HTMLElement>(`[data-feedback-id="${focusOn.id}"]`)?.focus();
    }
  }, [focusOn]);

  if (state.status !== "loaded") {
    return <PageStatus state={state} onRetry={retry} />;
  }
  const { items, unread, nextCursor } = state.data;
  // Focus moves to `id`, or to the heading, which stays, when there is none.
  const moveFocus = (id: string | undefined) => {
    if (id === undefined) {
      setFocusOn(null);
      document.getElementById("inbox-page-title")?.focus();
    } else {
      setFocusOn({ id });
    }
  };
  return (
    <section aria-labelledby="inbox-page-title">
      <h2 id="inbox-page-title" tabIndex={-1} data-focus-after-change>
        {t("Inbox")}
      </h2>
      <p className="page-intro">
        {t(
          "About two hours after a visit, the customer's card links to a page where they can send you a private message, and every customer is offered your Google review link there too. Messages carry no name or number, so you cannot reply here.",
        )}
      </p>
      <p>{unread === 0 ? t("No unread messages.") : plural(lang, UNREAD, unread)}</p>
      <Notice>{notice === null ? null : notice(t, lang)}</Notice>
      <FormError message={error} />
      {items.length === 0 ? (
        <p className="empty">{t("No messages yet. What customers write about their visits arrives here.")}</p>
      ) : (
        <ul className="items" ref={list}>
          {items.map((item, index) => (
            <Message
              key={item.id}
              item={item}
              pending={pending}
              onRead={() => {
                setNotice(null);
                void submit(() => apiRequest("POST", `/api/feedback/${item.id}/read`, feedbackReadSchema)).then((result) => {
                  if (result.ok) {
                    // The button goes with the unread state: focus moves on to the next unread message (an earlier one
                    // when it was the last), so the owner can read their way down the list.
                    const next = items.slice(index + 1).find((entry) => !entry.read) ?? items.slice(0, index).findLast((entry) => !entry.read);
                    setNotice(() => (say: Translate<typeof AR>, shownIn: Lang) => say("The message of {received} is marked as read.", { received: dateFormat(shownIn, TIME_OPTIONS).format(new Date(item.receivedAt)) }));
                    setData((current) => ({
                      ...current,
                      items: current.items.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)),
                      unread: Math.max(0, current.unread - 1),
                    }));
                    moveFocus(next?.id);
                    // The navigation's count, too.
                    attention.reload();
                  }
                });
              }}
            />
          ))}
        </ul>
      )}
      {nextCursor === null ? null : (
        <button
          type="button"
          aria-disabled={pending || undefined}
          onClick={() => {
            void submit(() => apiRequest("GET", `/api/feedback?cursor=${encodeURIComponent(nextCursor)}`, feedbackInboxSchema)).then((result) => {
              if (result.ok) {
                const known = new Set(items.map((entry) => entry.id));
                const added = result.value.items.filter((entry) => !known.has(entry.id));
                setData((current) => ({ items: [...current.items, ...added], unread: result.value.unread, nextCursor: result.value.nextCursor }));
                // Focus moves to what was loaded, and stays on the page when this button goes.
                moveFocus(added[0]?.id);
              }
            });
          }}
        >
          {t("Show older messages")}
        </button>
      )}
    </section>
  );
}
