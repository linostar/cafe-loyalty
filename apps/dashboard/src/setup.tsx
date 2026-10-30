import { cafeSetupSchema, joinLinkSchema, staffListSchema, type CafeSetup, type Devices, type PairingCode, type StaffMember } from "@cafe-loyalty/shared";
import { useEffect, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { apiRequest } from "./api.js";
import { OrderTypeForm, ProgramForm } from "./cafe-page.js";
import { NewCode, PairForm } from "./devices-page.js";
import { FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
import { useApiText, useCommonT, useT } from "./i18n.js";
import { PageStatus, useApiData, type ApiData } from "./session.js";
import { AddStaffForm } from "./staff-page.js";
import "./setup.css";

/** What the printed sheet says to customers, always in both languages whatever the dashboard's (D6). */
const SHEET_TEXT = ["Get your loyalty card", "Scan this code with your phone's camera and open the link. Every visit earns you a stamp."] as const;

const AR = {
  [SHEET_TEXT[0]]: "احصل على بطاقة الولاء",
  [SHEET_TEXT[1]]: "امسح هذا الرمز بكاميرا هاتفك وافتح الرابط. كل زيارة تكسبك ختماً.",
  "QR code customers scan to get a loyalty card": "رمز QR يمسحه الزبائن للحصول على بطاقة ولاء",
  Print: "طباعة",
  "Print the signup QR": "طباعة رمز QR للتسجيل",
  "Print this sheet and put it at the counter, where customers see it. It is in Arabic and English, whatever language the dashboard is in.":
    "اطبع هذه الورقة وضعها على الكاونتر حيث يراها الزبائن. هي بالعربية والإنكليزية، أياً كانت لغة لوحة التحكم.",
  "Back to the Café page": "العودة إلى صفحة المقهى",
  "Set up your café": "جهّز مقهاك",
  "Five steps get the counter ready for your first customers. Do each one now or skip it: Home lists whatever is left.":
    "خمس خطوات تجهّز الكاونتر لزبائنك الأوائل. أنجز كل خطوة الآن أو تخطَّها: تعرض الرئيسية ما تبقّى.",
  "Step {n} of {total}": "الخطوة {n} من {total}",
  "Your loyalty program": "برنامج الولاء",
  "How many stamps earn a reward, and what the reward is.": "كم ختماً يلزم للمكافأة، وما هي المكافأة.",
  "Your first order type": "نوع الطلب الأول",
  "What baristas give stamps for, such as an espresso drink. Add the rest of the menu on the Café page.":
    "ما يمنح الباريستا أختاماً عليه، مثل مشروب إسبريسو. أضف بقية القائمة من صفحة المقهى.",
  "Your first barista": "الباريستا الأول",
  "Each barista signs in on the counter phone with their own PIN.": "يسجّل كل باريستا الدخول على هاتف الكاونتر برمزه السري الخاص.",
  "Your counter phone": "هاتف الكاونتر",
  "The phone baristas record visits on. Create a code, then scan it on the phone or type it into the counter app.":
    "الهاتف الذي يسجّل عليه الباريستا الزيارات. أنشئ رمزاً، ثم امسحه على الهاتف أو اكتبه في تطبيق الكاونتر.",
  "Your signup QR": "رمز QR للتسجيل",
  "Customers scan it at the counter to get their loyalty card. Print it now, or later from the Café page.":
    "يمسحه الزبائن على الكاونتر للحصول على بطاقة الولاء. اطبعه الآن، أو لاحقاً من صفحة المقهى.",
  Done: "تم",
  "To do": "للإنجاز",
  Back: "السابق",
  Next: "التالي",
  "Skip this step": "تخطَّ هذه الخطوة",
  "Skip the rest": "تخطَّ البقية",
  "Finish setup": "إنهاء التجهيز",
  "Finish setting up": "أكمل التجهيز",
  "{done} of {total} done.": "أُنجز {done} من {total}.",
  "Set the program": "اضبط البرنامج",
  "Add an order type": "أضف نوع طلب",
  "Add a barista": "أضف باريستا",
  "Pair a phone": "اربط هاتفاً",
  "The pairing code for {name} has expired.": "انتهت صلاحية رمز ربط {name}.",
  "Print the QR": "اطبع الرمز",
  "Could not check your setup: {message}": "تعذّر التحقق من تجهيز مقهاك: {message}",
  "Could not check whether this step is done: {message}": "تعذّر التحقق مما إذا كانت هذه الخطوة منجزة: {message}",
  "Could not record this print for the setup checklist: {message}": "تعذّر تسجيل هذه الطباعة في قائمة التجهيز: {message}",
} as const;

/** The five setup steps (D1), in the wizard's order; Home's checklist lists the same (D22), each with where to do it. */
const STEPS = [
  { key: "program", title: "Your loyalty program", intro: "How many stamps earn a reward, and what the reward is.", action: "Set the program", href: "/cafe#program" },
  {
    key: "orderType",
    title: "Your first order type",
    intro: "What baristas give stamps for, such as an espresso drink. Add the rest of the menu on the Café page.",
    action: "Add an order type",
    href: "/cafe#menu",
  },
  { key: "barista", title: "Your first barista", intro: "Each barista signs in on the counter phone with their own PIN.", action: "Add a barista", href: "/staff" },
  {
    key: "phone",
    title: "Your counter phone",
    intro: "The phone baristas record visits on. Create a code, then scan it on the phone or type it into the counter app.",
    action: "Pair a phone",
    href: "/devices",
  },
  {
    key: "printed",
    title: "Your signup QR",
    intro: "Customers scan it at the counter to get their loyalty card. Print it now, or later from the Café page.",
    action: "Print the QR",
    href: "/cafe/print-qr",
  },
] as const;

export type SetupStep = (typeof STEPS)[number]["key"];

/** Which steps are done, from the café's own rows and when its signup QR was first printed (D22). */
export function setupProgress(setup: CafeSetup, staff: readonly StaffMember[], devices: Devices["devices"]): Record<SetupStep, boolean> {
  return {
    program: setup.program !== null,
    // One that earns stamps: a type on sale with none (a pastry) does not let baristas give any.
    orderType: setup.orderTypes.some((orderType) => orderType.active && orderType.stampsEarned > 0),
    barista: staff.some((member) => !member.revoked),
    phone: devices.some((device) => !device.revoked),
    printed: setup.cafe.signupQrPrintedAt !== null,
  };
}

const loaded = <T,>(state: ApiData<T>): T | null => (state.status === "loaded" ? state.data : null);

/**
 * The signup QR as printed (D6): the café's name, the code at about 8 cm on paper and how to use it in Arabic and
 * English, with a Print button; print CSS (setup.css) leaves only the sheet on paper. Printing records the first
 * print (`beforeprint` also catches the browser's own Print command), and `onRecorded` gets the café's setup; a
 * failed record is said under the button (an ended session goes back to sign-in).
 */
export function PrintQr({ cafeName, onRecorded }: { cafeName: string; onRecorded?: (setup: CafeSetup) => void }) {
  const t = useT(AR);
  const api = useApiText();
  const [state, , retry] = useApiData("/api/cafe/join", joinLinkSchema);
  const { error, submit } = useSubmit();
  const recorded = useRef(false);
  const ready = state.status === "loaded";
  useEffect(() => {
    if (!ready) {
      return;
    }
    const record = () => {
      if (recorded.current) {
        return;
      }
      recorded.current = true;
      // Printing goes ahead whatever the answer; a failed record is tried again on the next print.
      void submit(() => apiRequest("POST", "/api/cafe/join/printed", cafeSetupSchema)).then((result) => {
        if (result.ok) {
          onRecorded?.(result.value);
        } else {
          recorded.current = false;
        }
      });
    };
    window.addEventListener("beforeprint", record);
    return () => {
      window.removeEventListener("beforeprint", record);
    };
  }, [ready, onRecorded, submit]);
  if (state.status !== "loaded") {
    return <PageStatus state={state} onRetry={retry} />;
  }
  const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(state.data.joinUrl, { border: 4 }))}`;
  return (
    <>
      <div className="print-sheet card">
        <p className="print-cafe">{cafeName}</p>
        <img className="print-qr" src={qr} alt={t("QR code customers scan to get a loyalty card")} width={302} height={302} />
        {(["ar", "en"] as const).map((lang) => (
          <div key={lang} lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} className="print-text">
            <p className="print-title">{lang === "ar" ? AR[SHEET_TEXT[0]] : SHEET_TEXT[0]}</p>
            <p>{lang === "ar" ? AR[SHEET_TEXT[1]] : SHEET_TEXT[1]}</p>
          </div>
        ))}
      </div>
      <p>
        <button
          type="button"
          className="primary"
          onClick={() => {
            window.print();
          }}
        >
          {t("Print")}
        </button>
      </p>
      {error === null ? null : (
        <p role="alert" className="form-error">
          {t("Could not record this print for the setup checklist: {message}", { message: api(error) })}
        </p>
      )}
    </>
  );
}

/** `/cafe/print-qr`: the signup QR's printable sheet (D6). */
export function PrintQrPage({ cafeName }: { cafeName: string }) {
  const t = useT(AR);
  return (
    <section aria-labelledby="print-qr-title">
      <h2 id="print-qr-title">{t("Print the signup QR")}</h2>
      <p className="page-intro">
        {t("Print this sheet and put it at the counter, where customers see it. It is in Arabic and English, whatever language the dashboard is in.")}
      </p>
      <PrintQr cafeName={cafeName} />
      <p>
        <a href="/cafe#signup">{t("Back to the Café page")}</a>
      </p>
    </section>
  );
}

/**
 * The first-run wizard (D1), shown on Home until the setup is finished: one step at a time, each done in place with the
 * page's own form or skipped. Finishing, or skipping the rest, records it on the server (`onSetup` then gets a setup
 * with `setupFinishedAt`), so no device or co-owner sees the wizard again. Focus goes to each step's heading. The
 * counter phones are Home's own load (`devices`): `reloadDevices` loads them again quietly, `retryDevices` after a failure.
 */
export function SetupWizard({
  setup,
  onSetup,
  devices,
  reloadDevices,
  retryDevices,
}: {
  setup: CafeSetup;
  onSetup: (setup: CafeSetup) => void;
  devices: ApiData<Devices>;
  reloadDevices: () => void;
  retryDevices: () => void;
}) {
  const t = useT(AR);
  const common = useCommonT();
  const api = useApiText();
  const [index, setIndex] = useState(0);
  const [staff, setStaff, retryStaff] = useApiData("/api/staff", staffListSchema);
  const [newCode, setNewCode] = useState<PairingCode | null>(null);
  /** The phone whose code ran out while shown, said once (the code's countdown is not announced). */
  const [expired, setExpired] = useState<string | null>(null);
  const { pending, error, submit } = useSubmit();
  const wizard = useFocusOnChange<HTMLElement>(index);
  // By the code's id: a renewed code (New code) takes focus too, as on the Devices page.
  const pairing = useFocusOnChange<HTMLDivElement>(newCode?.id ?? null);
  const step = STEPS[index] ?? STEPS[0];
  const last = index === STEPS.length - 1;
  const done = setupProgress(setup, loaded(staff)?.staff ?? [], loaded(devices)?.devices ?? [])[step.key];
  // A list that did not load leaves its step looking not done: said, with Try again, rather than shown as empty.
  const unchecked = step.key === "barista" && staff.status === "failed" ? { ...staff, retry: retryStaff } : step.key === "phone" && devices.status === "failed" ? { ...devices, retry: retryDevices } : null;

  const save = async (method: "PATCH" | "PUT" | "POST", path: string, body: unknown) => {
    onSetup(await apiRequest(method, path, cafeSetupSchema, body));
    return true;
  };
  const finish = () => {
    void submit(() => apiRequest("POST", "/api/cafe/setup/finish", cafeSetupSchema)).then((result) => {
      if (result.ok) {
        onSetup(result.value);
      }
    });
  };

  return (
    <section ref={wizard} aria-labelledby="setup-title" className="setup-wizard">
      <h2 id="setup-title">{t("Set up your café")}</h2>
      <p className="page-intro">{t("Five steps get the counter ready for your first customers. Do each one now or skip it: Home lists whatever is left.")}</p>
      <div className="stack">
        <div>
          <h3 id="setup-step-title" tabIndex={-1} data-focus-target>
            <span className="setup-step-count">{t("Step {n} of {total}", { n: index + 1, total: STEPS.length })}</span> {t(step.title)}
          </h3>
          <p>{t(step.intro)}</p>
          {done ? (
            <p>
              <span className="badge badge-success">{t("Done")}</span>
            </p>
          ) : null}
          {unchecked === null ? null : (
            <>
              <p role="alert" className="form-error">
                {t("Could not check whether this step is done: {message}", { message: api(unchecked.message) })}
              </p>
              <button type="button" onClick={unchecked.retry}>
                {common("Try again")}
              </button>
            </>
          )}
        </div>
        {step.key === "program" ? (
          <ProgramForm program={setup.program} save={save} />
        ) : step.key === "orderType" ? (
          <div className="card">
            <OrderTypeForm save={save} />
          </div>
        ) : step.key === "barista" ? (
          <AddStaffForm
            change={async (method, path, body) => {
              setStaff(await apiRequest(method, path, staffListSchema, body));
            }}
          />
        ) : step.key === "phone" ? (
          <div ref={pairing}>
            {newCode === null ? (
              <PairForm onCreated={setNewCode} />
            ) : (
              <NewCode
                key={newCode.id}
                code={newCode}
                onDone={() => {
                  setNewCode(null);
                  setExpired(null);
                  // Paired on the phone meanwhile, perhaps: the list says.
                  reloadDevices();
                }}
                onExpired={setExpired}
                onRenewed={(code) => {
                  setExpired(null);
                  setNewCode(code);
                }}
              />
            )}
            <Notice>{expired === null ? null : t("The pairing code for {name} has expired.", { name: expired })}</Notice>
          </div>
        ) : (
          <PrintQr cafeName={setup.cafe.name} onRecorded={onSetup} />
        )}
        <FormError message={error} />
        <div className="actions">
          {index > 0 ? (
            <button
              type="button"
              onClick={() => {
                setIndex(index - 1);
              }}
            >
              {t("Back")}
            </button>
          ) : null}
          {last ? (
            <button type="button" className="primary" aria-disabled={pending || undefined} onClick={finish}>
              {t("Finish setup")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setIndex(index + 1);
                }}
              >
                {done ? t("Next") : t("Skip this step")}
              </button>
              <button type="button" aria-disabled={pending || undefined} onClick={finish}>
                {t("Skip the rest")}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Home's setup checklist (D22), once the wizard is behind: the five steps, each done or with a link to do it, from the
 * café's data. Hidden once every step is done, and while the lists it needs are loading. `devices` is Home's own load,
 * shared with Needs you (`retryDevices` loads it again); a list that failed offers Try again.
 */
export function SetupChecklist({ setup, devices, retryDevices }: { setup: CafeSetup; devices: ApiData<Devices>; retryDevices: () => void }) {
  const t = useT(AR);
  const common = useCommonT();
  const api = useApiText();
  const [staff, , retryStaff] = useApiData("/api/staff", staffListSchema);
  const failed = staff.status === "failed" ? staff : devices.status === "failed" ? devices : null;
  if (failed !== null) {
    return (
      <>
        <p className="form-error">{t("Could not check your setup: {message}", { message: api(failed.message) })}</p>
        <button
          type="button"
          onClick={() => {
            if (staff.status === "failed") {
              retryStaff();
            }
            if (devices.status === "failed") {
              retryDevices();
            }
          }}
        >
          {common("Try again")}
        </button>
      </>
    );
  }
  const staffList = loaded(staff);
  const deviceList = loaded(devices);
  if (staffList === null || deviceList === null) {
    return null;
  }
  const progress = setupProgress(setup, staffList.staff, deviceList.devices);
  const count = STEPS.filter((step) => progress[step.key]).length;
  if (count === STEPS.length) {
    return null;
  }
  return (
    <section aria-labelledby="setup-checklist-title" className="card">
      <h3 id="setup-checklist-title">{t("Finish setting up")}</h3>
      <p className="hint">{t("{done} of {total} done.", { done: count, total: STEPS.length })}</p>
      <ul className="attention">
        {STEPS.map((step) => (
          <li key={step.key}>
            <span className={progress[step.key] ? "badge badge-success" : "badge"}>{progress[step.key] ? t("Done") : t("To do")}</span>
            <span className="attention-text">{t(step.title)}</span>
            {progress[step.key] ? null : (
              <a className="action-link" href={step.href}>
                {t(step.action)}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
