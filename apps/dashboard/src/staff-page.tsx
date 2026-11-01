import { STAFF_PIN_MAX_LENGTH, staffListSchema, type StaffMember, toLatinDigits } from "@cafe-loyalty/shared";
import { useState } from "react";
import { apiRequest, isStale } from "./api.js";
import { ConfirmButton, Field, Form, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
import type { UnsavedChanges } from "./unsaved-changes.js";
import { useT, type Later, useLang, type Translate } from "./i18n.js";
import { PageStatus, useApiData } from "./session.js";

const PIN_HINT = "6 to 12 digits; not a repeated digit or a run like 123456. Tell it to the barista in person, and pick one they use nowhere else.";

const AR = {
  [PIN_HINT]: "من 6 إلى 12 رقماً، لا رقماً مكرراً ولا تسلسلاً مثل 123456. أخبر به الباريستا شخصياً، واختر رمزاً لا يستخدمه في أي مكان آخر.",
  "Add a barista": "إضافة باريستا",
  Name: "الاسم",
  PIN: "الرمز السري",
  "Adding…": "جارٍ الإضافة…",
  "Add barista": "إضافة الباريستا",
  removed: "أُزيل",
  "New PIN for {name}": "رمز سري جديد لـ{name}",
  "Save PIN": "حفظ الرمز السري",
  "Change PIN for {name}": "تغيير الرمز السري لـ{name}",
  "Change PIN": "تغيير الرمز السري",
  "Remove {name}": "إزالة {name}",
  "Yes, remove {name}": "نعم، أزل {name}",
  "Saved. Counter phones pick up the change when they next sync.": "تم الحفظ. تتلقى هواتف الكاونتر التغيير عند مزامنتها التالية.",
  Staff: "الموظفون",
  "Baristas sign in on the counter phones with their PIN, and every stamp they give is recorded under their name.":
    "يسجّل الباريستا الدخول على هواتف الكاونتر برمزهم السري، ويُسجَّل كل ختم يمنحونه باسمهم.",
  "No baristas yet. Each one gets a PIN to use at the counter.": "لا باريستا بعد. يحصل كل واحد منهم على رمز سري يستخدمه على الكاونتر.",
  "Removed ({count})": "المُزالون ({count})",
} as const;

type Change = (method: "POST" | "PATCH", path: string, body?: unknown) => Promise<void>;

/** After a failure that means the list is out of date (the barista was removed elsewhere), reload it. */
const reloadIfStale = (reload: () => void) => (result: { ok: boolean; error?: unknown }) => {
  if (!result.ok && isStale(result.error)) {
    reload();
  }
};

export function AddStaffForm({ change, unsaved }: { change: Change; unsaved?: UnsavedChanges }) {
  const t = useT(AR);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const { pending, error, fieldErrors, done, clearDone, submit } = useSubmit();
  return (
    <Form
      aria-labelledby="add-staff-title"
      unsaved={unsaved}
      className="card form-grid"
      onChange={clearDone}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => change("POST", "/api/staff", { name, pin: toLatinDigits(pin) })).then((result) => {
          if (result.ok) {
            setName("");
            setPin("");
          }
        });
      }}
    >
      <h3 id="add-staff-title">{t("Add a barista")}</h3>
      <FormError message={error} />
      <Field label={t("Name")} name="name" type="text" autoComplete="off" value={name} onChange={setName} maxLength={60} error={fieldErrors.name} />
      <Field
        label={t("PIN")}
        name="pin"
        type="password"
        autoComplete="new-password"
        inputMode="numeric"
        value={pin}
        onChange={setPin}
        maxLength={STAFF_PIN_MAX_LENGTH}
        hint={t(PIN_HINT)}
        error={fieldErrors.pin}
      />
      <button type="submit" aria-disabled={pending || undefined}>
        {pending ? t("Adding…") : t("Add barista")}
      </button>
      <Notice>{done ? t("Saved. Counter phones pick up the change when they next sync.") : null}</Notice>
    </Form>
  );
}

function StaffItem({ member, change, reload }: { member: StaffMember; change: Change; reload: () => void }) {
  const t = useT(AR);
  const [changingPin, setChangingPin] = useState(false);
  const [pin, setPin] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();
  const item = useFocusOnChange<HTMLLIElement>(changingPin);

  return (
    <li ref={item} className="row">
      <span className="row-main">
        <strong>{member.name}</strong>
        {member.revoked ? (
          <>
            {" "}
            <span className="badge">
              <span className="visually-hidden">· </span>
              {t("removed")}
            </span>
          </>
        ) : null}
      </span>
      <FormError message={error} />
      {member.revoked ? null : changingPin ? (
        <Form
          aria-label={t("New PIN for {name}", { name: member.name })}
          className="row-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(() => change("PATCH", `/api/staff/${member.id}`, { pin: toLatinDigits(pin) })).then((result) => {
              if (result.ok) {
                setChangingPin(false);
                setPin("");
              }
              reloadIfStale(reload)(result);
            });
          }}
        >
          <Field
            label={t("New PIN for {name}", { name: member.name })}
            name="pin"
            type="password"
            autoComplete="new-password"
            inputMode="numeric"
            value={pin}
            onChange={setPin}
            maxLength={STAFF_PIN_MAX_LENGTH}
            hint={t(PIN_HINT)}
            error={fieldErrors.pin}
          />
          <div className="actions">
            <button type="submit" aria-disabled={pending || undefined}>
              {pending ? t("Saving…") : t("Save PIN")}
            </button>
            <button
              type="button"
              onClick={() => {
                setChangingPin(false);
                setPin("");
              }}
            >
              {t("Cancel")}
            </button>
          </div>
        </Form>
      ) : (
        <span className="actions">
          <button
            type="button"
            aria-label={t("Change PIN for {name}", { name: member.name })}
            onClick={() => {
              setChangingPin(true);
            }}
          >
            {t("Change PIN")}
          </button>
          <ConfirmButton
            label={t("Remove {name}", { name: member.name })}
            confirmLabel={t("Yes, remove {name}", { name: member.name })}
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
  const t = useT(AR);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setList, retry] = useApiData("/api/staff", staffListSchema, reloadKey);
  const reload = () => {
    setReloadKey((value) => value + 1);
  };
  const lang = useLang();
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} onRetry={retry} />;
  }
  const staff = state.data.staff;
  const active = staff.filter((member) => !member.revoked);
  const removed = staff.filter((member) => member.revoked);

  const change: Change = async (method, path, body) => {
    setList(await apiRequest(method, path, staffListSchema, body));
  };
  // A change to a barista in the list is said under the page's heading, where focus goes once it is made; the form
  // that adds one says so next to its own button.
  const changeAndSay: Change = async (method, path, body) => {
    setNotice(null);
    await change(method, path, body);
    setNotice(() => (say: Translate<typeof AR>) => say("Saved. Counter phones pick up the change when they next sync."));
  };

  return (
    <section aria-labelledby="staff-page-title">
      <h2 id="staff-page-title" tabIndex={-1} data-focus-after-change>
        {t("Staff")}
      </h2>
      <p className="page-intro">{t("Baristas sign in on the counter phones with their PIN, and every stamp they give is recorded under their name.")}</p>
      <Notice>{notice === null ? null : notice(t, lang)}</Notice>
      {staff.length === 0 ? (
        <p className="empty">{t("No baristas yet. Each one gets a PIN to use at the counter.")}</p>
      ) : (
        <>
          {active.length === 0 ? null : (
            <ul className="items">
              {active.map((member) => (
                <StaffItem key={member.id} member={member} change={changeAndSay} reload={reload} />
              ))}
            </ul>
          )}
          {/* Removed baristas stay listed, out of the way: what they recorded may still be under Review. */}
          {removed.length === 0 ? null : (
            <details>
              <summary>{t("Removed ({count})", { count: removed.length })}</summary>
              <ul className="items">
                {removed.map((member) => (
                  <StaffItem key={member.id} member={member} change={changeAndSay} reload={reload} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <AddStaffForm change={change} />
    </section>
  );
}
