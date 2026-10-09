import { STAFF_PIN_MAX_LENGTH, staffListSchema, type StaffMember } from "@cafe-loyalty/shared";
import { useState } from "react";
import { apiRequest, isStale } from "./api.js";
import { ConfirmButton, Field, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
import { PageStatus, useApiData } from "./session.js";

const PIN_HINT = "6 to 12 digits; not a repeated digit or a run like 123456. Tell it to the barista in person.";

type Change = (method: "POST" | "PATCH", path: string, body?: unknown) => Promise<void>;

/** After a failure that means the list is out of date (the barista was removed elsewhere), reload it. */
const reloadIfStale = (reload: () => void) => (result: { ok: boolean; error?: unknown }) => {
  if (!result.ok && isStale(result.error)) {
    reload();
  }
};

function AddStaffForm({ change }: { change: Change }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="add-staff-title"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => change("POST", "/api/staff", { name, pin })).then((result) => {
          if (result.ok) {
            setName("");
            setPin("");
          }
        });
      }}
    >
      <h3 id="add-staff-title">Add a barista</h3>
      <FormError message={error} />
      <Field label="Name" name="name" type="text" autoComplete="off" value={name} onChange={setName} maxLength={60} error={fieldErrors.name} />
      <Field
        label="PIN"
        name="pin"
        type="password"
        autoComplete="new-password"
        inputMode="numeric"
        value={pin}
        onChange={setPin}
        maxLength={STAFF_PIN_MAX_LENGTH}
        hint={PIN_HINT}
        error={fieldErrors.pin}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add barista"}
      </button>
    </form>
  );
}

function StaffItem({ member, change, reload }: { member: StaffMember; change: Change; reload: () => void }) {
  const [changingPin, setChangingPin] = useState(false);
  const [pin, setPin] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();
  const item = useFocusOnChange<HTMLLIElement>(changingPin);

  return (
    <li ref={item}>
      <strong>{member.name}</strong>
      {member.revoked ? " · removed" : null}
      <FormError message={error} />
      {member.revoked ? null : changingPin ? (
        <form
          aria-label={`New PIN for ${member.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            void submit(() => change("PATCH", `/api/staff/${member.id}`, { pin })).then((result) => {
              if (result.ok) {
                setChangingPin(false);
                setPin("");
              }
              reloadIfStale(reload)(result);
            });
          }}
        >
          <Field
            label={`New PIN for ${member.name}`}
            name="pin"
            type="password"
            autoComplete="new-password"
            inputMode="numeric"
            value={pin}
            onChange={setPin}
            maxLength={STAFF_PIN_MAX_LENGTH}
            hint={PIN_HINT}
            error={fieldErrors.pin}
          />
          <button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save PIN"}
          </button>
          <button
            type="button"
            onClick={() => {
              setChangingPin(false);
              setPin("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <span className="actions">
          <button
            type="button"
            aria-label={`Change PIN for ${member.name}`}
            onClick={() => {
              setChangingPin(true);
            }}
          >
            Change PIN
          </button>
          <ConfirmButton
            label={`Remove ${member.name}`}
            confirmLabel={`Yes, remove ${member.name}`}
            pending={pending}
            onConfirm={() => {
              void submit(() => change("POST", `/api/staff/${member.id}/revoke`)).then(reloadIfStale(reload));
            }}
          />
        </span>
      )}
    </li>
  );
}

/** `/staff`: baristas and their PINs (AC 19). */
export function StaffPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setList] = useApiData("/api/staff", staffListSchema, reloadKey);
  const reload = () => {
    setReloadKey((value) => value + 1);
  };
  const [notice, setNotice] = useState<string | null>(null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const staff = state.data.staff;

  const change: Change = async (method, path, body) => {
    setNotice(null);
    setList(await apiRequest(method, path, staffListSchema, body));
    setNotice("Saved. Counter phones pick up the change when they next sync.");
  };

  return (
    <section aria-labelledby="staff-page-title">
      <h2 id="staff-page-title" tabIndex={-1} data-focus-after-change>
        Staff
      </h2>
      {notice === null ? null : <Notice>{notice}</Notice>}
      {staff.length === 0 ? (
        <p>No baristas yet. Each one gets a PIN to use at the counter.</p>
      ) : (
        <ul className="items">
          {staff.map((member) => (
            <StaffItem key={member.id} member={member} change={change} reload={reload} />
          ))}
        </ul>
      )}
      <AddStaffForm change={change} />
    </section>
  );
}
