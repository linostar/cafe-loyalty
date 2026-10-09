import { reviewQueueSchema, type ReviewItem, type SyncHoldReason } from "@cafe-loyalty/shared";
import { useEffect, useRef, useState } from "react";
import { apiRequest, isStale, noContent } from "./api.js";
import { ConfirmButton, FormError, Notice, useSubmit } from "./forms.js";
import { PageStatus, useApiData } from "./session.js";

// To the second, so two items from the same phone and barista still get different button names.
const timeFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" });

const TYPE_LABELS: Readonly<Record<string, string>> = { "visit.recorded": "Visit", "staff.pin_lockout": "PIN lockout report" };

const REASONS: Readonly<Record<SyncHoldReason, string>> = {
  device_revoked: "from a phone you removed",
  staff_revoked: "by a barista you removed",
  late_sync: "that reached the server more than two days later",
};

/** What an item is, for its buttons and for the confirmation after a decision. */
function describe(item: ReviewItem): string {
  return `${TYPE_LABELS[item.type] ?? item.type} by ${item.staffName} on ${item.deviceName} at ${timeFormat.format(new Date(item.occurredAt))}`;
}

function ReviewEntry({ item, pending, onDecide }: { item: ReviewItem; pending: boolean; onDecide: (decision: "accept" | "discard") => void }) {
  return (
    <li tabIndex={-1} data-review-id={item.id}>
      <strong>{TYPE_LABELS[item.type] ?? item.type}</strong> at {timeFormat.format(new Date(item.occurredAt))} {REASONS[item.reason]}: {item.staffName} on{" "}
      {item.deviceName}
      <div className="actions">
        <ConfirmButton
          label={`Accept ${describe(item)}`}
          confirmLabel={`Yes, accept ${describe(item)}`}
          pending={pending}
          onConfirm={() => {
            onDecide("accept");
          }}
        />
        <ConfirmButton
          label={`Discard ${describe(item)}`}
          confirmLabel={`Yes, discard ${describe(item)}`}
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
  const [reload, setReload] = useState(0);
  const [state] = useApiData("/api/review-queue", reviewQueueSchema, reload);
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
        Review
      </h2>
      <p>
        When you remove a phone or a barista, what they recorded and had not yet sent waits here instead of counting, as do visits a phone sent more than two
        days after they happened. Accept what you trust and discard the rest.
      </p>
      {notice === null ? null : <Notice>{notice}</Notice>}
      <FormError message={error} />
      {shown.length === 0 ? (
        <p>Nothing to review.</p>
      ) : (
        <ul className="items" ref={list}>
          {shown.map((item) => (
            <ReviewEntry
              key={item.id}
              item={item}
              pending={pending}
              onDecide={(decision) => {
                setNotice(null);
                void submit(() => apiRequest("POST", `/api/review-queue/${item.id}/${decision}`, noContent)).then((result) => {
                  if (result.ok) {
                    // Taken off the list in place, so the owner keeps every page already loaded.
                    setItems(shown.filter((entry) => entry.id !== item.id));
                    setNextCursor(cursor);
                    setNotice(`${decision === "accept" ? "Accepted" : "Discarded"}: ${describe(item)}.`);
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
          Show more
        </button>
      )}
    </section>
  );
}
