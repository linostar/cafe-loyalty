import { reviewQueueSchema, type ReviewItem, type ReviewQueue, type SyncHoldReason } from "@cafe-loyalty/shared";
import { useState } from "react";
import { apiRequest, isStale, noContent } from "./api.js";
import { ConfirmButton, FormError, Notice, useSubmit } from "./forms.js";
import { PageStatus, useApiData } from "./session.js";

const timeFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

const TYPE_LABELS: Readonly<Record<string, string>> = { "visit.recorded": "Visit", "staff.pin_lockout": "PIN lockout report" };

const REASONS: Readonly<Record<SyncHoldReason, string>> = {
  device_revoked: "from a phone you removed",
  staff_revoked: "by a barista you removed",
};

function ReviewEntry({ item, pending, onDecide }: { item: ReviewItem; pending: boolean; onDecide: (decision: "accept" | "discard") => void }) {
  const label = TYPE_LABELS[item.type] ?? item.type;
  const when = timeFormat.format(new Date(item.occurredAt));
  return (
    <li>
      <strong>{label}</strong> at {when} {REASONS[item.reason]}: {item.staffName} on {item.deviceName}
      <div className="actions">
        <ConfirmButton
          label={`Accept ${label.toLowerCase()} of ${when}`}
          confirmLabel="Yes, accept it"
          pending={pending}
          onConfirm={() => {
            onDecide("accept");
          }}
        />
        <ConfirmButton
          label={`Discard ${label.toLowerCase()} of ${when}`}
          confirmLabel="Yes, discard it"
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
  const [later, setLater] = useState<ReviewQueue | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { pending, error, submit } = useSubmit();
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const items = [...state.data.items, ...(later?.items ?? [])];
  const nextCursor = later === null ? state.data.nextCursor : later.nextCursor;
  const refresh = () => {
    setLater(null);
    setReload((value) => value + 1);
  };

  return (
    <section aria-labelledby="review-page-title">
      <h2 id="review-page-title" tabIndex={-1} data-focus-after-change>
        Review
      </h2>
      <p>
        When you remove a phone or a barista, what they recorded and had not yet sent waits here instead of counting. Accept what you trust and discard the
        rest.
      </p>
      {notice === null ? null : <Notice>{notice}</Notice>}
      <FormError message={error} />
      {items.length === 0 ? (
        <p>Nothing to review.</p>
      ) : (
        <ul className="items">
          {items.map((item) => (
            <ReviewEntry
              key={item.id}
              item={item}
              pending={pending}
              onDecide={(decision) => {
                void submit(() => apiRequest("POST", `/api/review-queue/${item.id}/${decision}`, noContent)).then((result) => {
                  if (result.ok) {
                    setNotice(decision === "accept" ? "Accepted." : "Discarded.");
                    refresh();
                  } else if (isStale(result.error)) {
                    refresh();
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
          disabled={pending}
          onClick={() => {
            void submit(() => apiRequest("GET", `/api/review-queue?cursor=${encodeURIComponent(nextCursor)}`, reviewQueueSchema)).then((result) => {
              if (result.ok) {
                setLater({ items: [...(later?.items ?? []), ...result.value.items], nextCursor: result.value.nextCursor });
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
