import { feedbackInboxSchema, feedbackReadSchema, type FeedbackItem } from "@cafe-loyalty/shared";
import { apiRequest } from "./api.js";
import { FormError, useSubmit } from "./forms.js";
import { PageStatus, useApiData } from "./session.js";

const timeFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

function Message({ item, pending, onRead }: { item: FeedbackItem; pending: boolean; onRead: () => void }) {
  const received = timeFormat.format(new Date(item.receivedAt));
  return (
    <li className="feedback-item">
      <p className="feedback-meta">
        {item.read ? null : (
          <>
            <span className="badge badge-accent">New</span>{" "}
          </>
        )}
        Received {received}, about a visit in the hour from {timeFormat.format(new Date(item.visitedAt))}
      </p>
      <p className="feedback-message">{item.message}</p>
      {item.read ? null : (
        <div className="actions">
          <button type="button" disabled={pending} onClick={onRead}>
            Mark the message of {received} as read
          </button>
        </div>
      )}
    </li>
  );
}

/** `/inbox`: customers' private feedback about their visits (AC 37), newest first. */
export function InboxPage() {
  const [state, setData] = useApiData("/api/feedback", feedbackInboxSchema);
  const { pending, error, submit } = useSubmit();
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const { items, unread, more } = state.data;
  return (
    <section aria-labelledby="inbox-page-title">
      <h2 id="inbox-page-title" tabIndex={-1} data-focus-after-change>
        Inbox
      </h2>
      <p className="page-intro">
        About two hours after a visit, the customer&apos;s card links to a page where they can send you a private message, and every customer is offered
        your Google review link there too. Messages carry no name or number, so you cannot reply here.
      </p>
      <p>{unread === 0 ? "No unread messages." : `${String(unread)} unread ${unread === 1 ? "message" : "messages"}.`}</p>
      <FormError message={error} />
      {items.length === 0 ? (
        <p className="empty">No messages yet. What customers write about their visits arrives here.</p>
      ) : (
        <ul className="items">
          {items.map((item) => (
            <Message
              key={item.id}
              item={item}
              pending={pending}
              onRead={() => {
                void submit(() => apiRequest("POST", `/api/feedback/${item.id}/read`, feedbackReadSchema)).then((result) => {
                  if (result.ok) {
                    setData({ items: items.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)), unread: Math.max(0, unread - 1), more });
                  }
                });
              }}
            />
          ))}
        </ul>
      )}
      {more ? <p className="hint">Older messages are not shown.</p> : null}
    </section>
  );
}
