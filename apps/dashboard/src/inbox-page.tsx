import { feedbackInboxSchema, feedbackReadSchema, plural, type FeedbackItem, type Lang } from "@cafe-loyalty/shared";
import { apiRequest } from "./api.js";
import { useContext, useState } from "react";
import { FormError, Notice, useSubmit } from "./forms.js";
import { dateFormat, useLang, useT, type Later, type Translate } from "./i18n.js";
import { AttentionContext, PageStatus, useApiData } from "./session.js";

const AR = {
  New: "جديدة",
  "Received {received}, about a visit in the hour from {hour}": "وصلت {received}، عن زيارة في الساعة التي تبدأ {hour}",
  "Mark the message of {received} as read": "تعليم رسالة {received} كمقروءة",
  Inbox: "الوارد",
  "About two hours after a visit, the customer's card links to a page where they can send you a private message, and every customer is offered your Google review link there too. Messages carry no name or number, so you cannot reply here.":
    "بعد نحو ساعتين من الزيارة، تربط بطاقة الزبون بصفحة يمكنه فيها إرسال رسالة خاصة إليك، ويُعرض هناك أيضاً على كل زبون رابط تقييمك على Google. لا تحمل الرسائل اسماً ولا رقماً، لذا لا يمكنك الرد هنا.",
  "No unread messages.": "لا رسائل غير مقروءة.",
  "No messages yet. What customers write about their visits arrives here.": "لا رسائل بعد. ما يكتبه الزبائن عن زياراتهم يصل إلى هنا.",
  "The message of {received} is marked as read.": "عُلّمت رسالة {received} كمقروءة.",
  "Older messages are not shown.": "الرسائل الأقدم غير معروضة.",
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
    <li className="feedback-item">
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
          <button type="button" aria-disabled={pending || undefined} onClick={onRead}>
            {t("Mark the message of {received} as read", { received })}
          </button>
        </div>
      )}
    </li>
  );
}

/** `/inbox`: customers' private feedback about their visits (AC 37), newest first. */
export function InboxPage() {
  const t = useT(AR);
  const lang = useLang();
  const [state, setData] = useApiData("/api/feedback", feedbackInboxSchema);
  const attention = useContext(AttentionContext);
  const { pending, error, submit } = useSubmit();
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const { items, unread, more } = state.data;
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
        <ul className="items">
          {items.map((item) => (
            <Message
              key={item.id}
              item={item}
              pending={pending}
              onRead={() => {
                setNotice(null);
                void submit(() => apiRequest("POST", `/api/feedback/${item.id}/read`, feedbackReadSchema)).then((result) => {
                  if (result.ok) {
                    // The button goes with the unread state, so focus moves to the heading, which stays.
                    document.getElementById("inbox-page-title")?.focus();
                    setNotice(() => (say: Translate<typeof AR>, shownIn: Lang) => say("The message of {received} is marked as read.", { received: dateFormat(shownIn, TIME_OPTIONS).format(new Date(item.receivedAt)) }));
                    setData({ items: items.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)), unread: Math.max(0, unread - 1), more });
                    // The navigation's count, too.
                    attention.reload();
                  }
                });
              }}
            />
          ))}
        </ul>
      )}
      {more ? <p className="hint">{t("Older messages are not shown.")}</p> : null}
    </section>
  );
}
