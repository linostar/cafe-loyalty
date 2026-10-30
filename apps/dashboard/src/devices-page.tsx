import { devicesSchema, pairingCodeSchema, type Devices, type PairingCode } from "@cafe-loyalty/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { renderSVG } from "uqr";
import { apiRequest, isStale, noContent } from "./api.js";
import { ConfirmButton, Field, Form, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
import { dateFormat, useLang, useT, type Later, type Translate } from "./i18n.js";
import { PageStatus, useApiData } from "./session.js";

const AR = {
  "Pair {name}": "اربط {name}",
  "On the counter phone, scan this code with the camera, or open the counter app and type the code.": "على هاتف الكاونتر، امسح هذا الرمز بالكاميرا، أو افتح تطبيق الكاونتر واكتب الرمز.",
  "QR code to pair {name}": "رمز QR لربط {name}",
  "Pairing code, letter by letter: {letters}": "رمز الربط، حرفاً حرفاً: {letters}",
  "It works once, until {time}. It is not shown again.": "يعمل مرة واحدة، حتى {time}. لن يظهر مجدداً.",
  "Expires in {left}.": "تنتهي صلاحيته بعد {left}.",
  "This code has expired. Create a new one to pair {name}.": "انتهت صلاحية هذا الرمز. أنشئ رمزاً جديداً لربط {name}.",
  "The pairing code for {name} has expired.": "انتهت صلاحية رمز ربط {name}.",
  "New code": "رمز جديد",
  "Removed ({count})": "المُزالة ({count})",
  Devices: "الأجهزة",
  Done: "تم",
  "Pair a counter phone": "اربط هاتف كاونتر",
  "Phone name": "اسم الهاتف",
  "So you can tell the phones apart, such as Front counter.": "لتمييز الهواتف عن بعضها، مثل الكاونتر الأمامي.",
  "Creating…": "جارٍ الإنشاء…",
  "Create pairing code": "إنشاء رمز ربط",
  "The phones and tablets your baristas record visits on. Pair a new one with a one-time code; remove one that is lost.":
    "الهواتف والأجهزة اللوحية التي يسجّل عليها الباريستا الزيارات. اربط جهازاً جديداً برمز لمرة واحدة، وأزل أي جهاز مفقود.",
  "Counter phones": "هواتف الكاونتر",
  "No phones paired yet. Pair one above to start recording visits at the counter.": "لا هواتف مربوطة بعد. اربط هاتفاً أعلاه لتبدأ بتسجيل الزيارات على الكاونتر.",
  "Every phone is removed. Each stops working the next time it connects. Pair one above to start again.": "أُزيلت كل الهواتف. يتوقف كل منها عن العمل عند اتصاله التالي. اربط هاتفاً أعلاه لتبدأ من جديد.",
  removed: "أُزيل",
  "last seen {time}": "آخر ظهور {time}",
  "Remove {name}": "إزالة {name}",
  "Yes, remove {name}": "نعم، أزل {name}",
  "{name} is removed. It stops working the next time it connects; anything it had not sent waits under Review.":
    "أُزيل {name}. يتوقف عن العمل عند اتصاله التالي، وما لم يرسله بعد ينتظر في المراجعة.",
  "Open pairing codes": "رموز الربط المفتوحة",
  "{name} · until {time}": "{name} · حتى {time}",
  "Cancel code for {name}": "إلغاء رمز {name}",
  "Cancel code": "إلغاء الرمز",
} as const;

/** The clock, ticking each second until `until` (ms) and then stopping. */
function useClockUntil(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= until) {
      return;
    }
    const timer = window.setTimeout(() => {
      setNow(Date.now());
    }, Math.min(1000, until - now));
    return () => {
      window.clearTimeout(timer);
    };
  }, [now, until]);
  return now;
}

/**
 * The new code, shown once: as text to type and as a QR that opens the counter app's pairing page (AC 17), with the
 * time it has left. The countdown is not a live region (it would speak every second): `onExpired` (stable) has the
 * page say once that it expired, and an expired code offers a new one for the same phone (`onRenewed`).
 */
export function NewCode({
  code,
  onDone,
  onExpired,
  onRenewed,
}: {
  code: PairingCode;
  onDone: () => void;
  onExpired: (deviceName: string) => void;
  onRenewed: (code: PairingCode) => void;
}) {
  const t = useT(AR);
  const lang = useLang();
  const expiresAt = Date.parse(code.expiresAt);
  const now = useClockUntil(expiresAt);
  const expired = now >= expiresAt;
  const { pending, error, submit } = useSubmit();
  /** Set by Done: a renewal answered after it is not shown, so a dismissed code never comes back. */
  const dismissed = useRef(false);
  useEffect(() => {
    if (expired) {
      onExpired(code.deviceName);
    }
  }, [expired, onExpired, code.deviceName]);
  const seconds = Math.ceil(Math.max(0, expiresAt - now) / 1000);
  const left = `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
  // A 4-module quiet zone, as the QR specification asks, so phone cameras read it reliably.
  const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(code.pairingUrl, { border: 4 }))}`;
  return (
    <section aria-labelledby="new-code-title" className="card new-code">
      <h3 id="new-code-title" tabIndex={-1} data-focus-target>
        {t("Pair {name}", { name: code.deviceName })}
      </h3>
      {expired ? (
        <>
          <p>{t("This code has expired. Create a new one to pair {name}.", { name: code.deviceName })}</p>
          <FormError message={error} />
        </>
      ) : (
        <>
          <p className="hint">{t("On the counter phone, scan this code with the camera, or open the counter app and type the code.")}</p>
          <img src={qr} alt={t("QR code to pair {name}", { name: code.deviceName })} width={200} height={200} />
          <p className="code" dir="ltr">
            <span aria-hidden="true">{code.code}</span>
            <span className="visually-hidden">{t("Pairing code, letter by letter: {letters}", { letters: Array.from(code.code.replace(/-/g, "")).join(" ") })}</span>
          </p>
          <p>{t("It works once, until {time}. It is not shown again.", { time: dateFormat(lang, { timeStyle: "short" }).format(new Date(code.expiresAt)) })}</p>
          <p>{t("Expires in {left}.", { left })}</p>
        </>
      )}
      {/* Done stays the same button as the code expires, so focus on it stays too. */}
      <div className="actions">
        {expired ? (
          <button
            type="button"
            className="primary"
            aria-disabled={pending || undefined}
            onClick={() => {
              void submit(() => apiRequest("POST", "/api/devices/pairing-codes", pairingCodeSchema, { deviceName: code.deviceName })).then((result) => {
                if (result.ok && !dismissed.current) {
                  onRenewed(result.value);
                }
              });
            }}
          >
            {pending ? t("Creating…") : t("New code")}
          </button>
        ) : null}
        <button
          type="button"
          className={expired ? undefined : "primary"}
          onClick={() => {
            dismissed.current = true;
            onDone();
          }}
        >
          {t("Done")}
        </button>
      </div>
    </section>
  );
}

export function PairForm({ onCreated }: { onCreated: (code: PairingCode) => void }) {
  const t = useT(AR);
  const [deviceName, setDeviceName] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <Form
      aria-labelledby="pair-title"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => apiRequest("POST", "/api/devices/pairing-codes", pairingCodeSchema, { deviceName }), { clearsForm: true }).then((result) => {
          if (result.ok) {
            setDeviceName("");
            onCreated(result.value);
          }
        });
      }}
    >
      <h3 id="pair-title">{t("Pair a counter phone")}</h3>
      <FormError message={error} />
      <Field
        label={t("Phone name")}
        name="deviceName"
        type="text"
        autoComplete="off"
        value={deviceName}
        onChange={setDeviceName}
        maxLength={60}
        hint={t("So you can tell the phones apart, such as Front counter.")}
        error={fieldErrors.deviceName}
      />
      <button type="submit" aria-disabled={pending || undefined}>
        {pending ? t("Creating…") : t("Create pairing code")}
      </button>
    </Form>
  );
}

/** `/devices`: paired counter phones, open pairing codes and revocation (AC 17, 21). */
export function DevicesPage() {
  const t = useT(AR);
  const lang = useLang();
  const [reload, setReload] = useState(0);
  const [state, setDevices, retry] = useApiData("/api/devices", devicesSchema, reload);
  const [newCode, setNewCode] = useState<PairingCode | null>(null);
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  const { pending, error, submit } = useSubmit();
  // Focus goes to the new code's heading as one shows (a new one too, as the button pressed goes), and to the form after Done.
  const pairing = useFocusOnChange<HTMLDivElement>(newCode?.id ?? null);
  const codeExpired = useCallback((name: string) => {
    setNotice(() => (say: Translate<typeof AR>) => say("The pairing code for {name} has expired.", { name }));
  }, []);
  if (state.status !== "loaded") {
    return <PageStatus state={state} onRetry={retry} />;
  }
  const devices: Devices = state.data;
  const timeFormat = dateFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const clockFormat = dateFormat(lang, { timeStyle: "short" });
  const active = devices.devices.filter((device) => !device.revoked);
  const removed = devices.devices.filter((device) => device.revoked);
  const deviceRow = (device: Devices["devices"][number]) => (
    <li key={device.id} className="row">
      <span className="row-main">
        <strong>{device.name}</strong>{" "}
        {device.revoked ? (
          <span className="badge">
            <span className="visually-hidden">· </span>
            {t("removed")}
          </span>
        ) : (
          <span className="row-meta">
            <span className="visually-hidden">· </span>
            {t("last seen {time}", { time: timeFormat.format(new Date(device.lastSeenAt)) })}
          </span>
        )}
      </span>
      {device.revoked ? null : (
        <ConfirmButton
          label={t("Remove {name}", { name: device.name })}
          confirmLabel={t("Yes, remove {name}", { name: device.name })}
          pending={pending}
          onConfirm={() => {
            void submit(() => apiRequest("POST", `/api/devices/${device.id}/revoke`, devicesSchema)).then((result) => {
              if (result.ok) {
                setDevices(result.value);
                setNotice(() => (say: Translate<typeof AR>) => say("{name} is removed. It stops working the next time it connects; anything it had not sent waits under Review.", { name: device.name }));
              } else if (isStale(result.error)) {
                setReload((value) => value + 1);
              }
            });
          }}
        />
      )}
    </li>
  );

  return (
    <section aria-labelledby="devices-page-title">
      <h2 id="devices-page-title" tabIndex={-1} data-focus-after-change>
        {t("Devices")}
      </h2>
      <p className="page-intro">{t("The phones and tablets your baristas record visits on. Pair a new one with a one-time code; remove one that is lost.")}</p>
      <Notice>{notice === null ? null : notice(t, lang)}</Notice>
      <FormError message={error} />
      <div ref={pairing}>
        {newCode === null ? (
          <PairForm
            onCreated={(code) => {
              setNotice(null);
              setNewCode(code);
            }}
          />
        ) : (
          <NewCode
            key={newCode.id}
            code={newCode}
            onDone={() => {
              setNewCode(null);
              setReload((value) => value + 1);
            }}
            onExpired={codeExpired}
            onRenewed={(code) => {
              setNotice(null);
              setNewCode(code);
            }}
          />
        )}
      </div>
      <h3>{t("Counter phones")}</h3>
      {devices.devices.length === 0 ? (
        <p className="empty">{t("No phones paired yet. Pair one above to start recording visits at the counter.")}</p>
      ) : (
        <>
          {active.length === 0 ? (
            <p className="empty">{t("Every phone is removed. Each stops working the next time it connects. Pair one above to start again.")}</p>
          ) : (
            <ul className="items">{active.map(deviceRow)}</ul>
          )}
          {/* Removed phones stay listed, out of the way: their queues may still be under Review. */}
          {removed.length === 0 ? null : (
            <details>
              <summary>{t("Removed ({count})", { count: removed.length })}</summary>
              <ul className="items">{removed.map(deviceRow)}</ul>
            </details>
          )}
        </>
      )}
      {devices.pairingCodes.length === 0 ? null : (
        <>
          <h3>{t("Open pairing codes")}</h3>
          <ul className="items">
            {devices.pairingCodes.map((code) => (
              <li key={code.id} className="row">
                <span className="row-main">
                  {t("{name} · until {time}", { name: code.deviceName, time: clockFormat.format(new Date(code.expiresAt)) })}
                </span>
                <button
                  type="button"
                  aria-disabled={pending || undefined}
                  aria-label={t("Cancel code for {name}", { name: code.deviceName })}
                  onClick={() => {
                    void submit(() => apiRequest("DELETE", `/api/devices/pairing-codes/${code.id}`, noContent)).then((result) => {
                      if (result.ok || isStale(result.error)) {
                        setReload((value) => value + 1);
                      }
                    });
                  }}
                >
                  {t("Cancel code")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
