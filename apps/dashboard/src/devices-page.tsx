import { devicesSchema, pairingCodeSchema, type Devices, type PairingCode } from "@cafe-loyalty/shared";
import { useState } from "react";
import { renderSVG } from "uqr";
import { apiRequest, isStale, noContent } from "./api.js";
import { ConfirmButton, Field, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
import { dateFormat, useLang, useT, type Later, type Translate } from "./i18n.js";
import { PageStatus, useApiData } from "./session.js";

const AR = {
  "Pair {name}": "اربط {name}",
  "On the counter phone, scan this code with the camera, or open the counter app and type the code.": "على هاتف الكاونتر، امسح هذا الرمز بالكاميرا، أو افتح تطبيق الكاونتر واكتب الرمز.",
  "QR code to pair {name}": "رمز QR لربط {name}",
  "Pairing code, letter by letter: {letters}": "رمز الربط، حرفاً حرفاً: {letters}",
  "It works once, until {time}. It is not shown again.": "يعمل مرة واحدة، حتى {time}. لن يظهر مجدداً.",
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

/** The new code, shown once: as text to type and as a QR that opens the counter app's pairing page (AC 17). */
function NewCode({ code, onDone }: { code: PairingCode; onDone: () => void }) {
  const t = useT(AR);
  const lang = useLang();
  // A 4-module quiet zone, as the QR specification asks, so phone cameras read it reliably.
  const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(code.pairingUrl, { border: 4 }))}`;
  return (
    <section aria-labelledby="new-code-title" className="card new-code">
      <h3 id="new-code-title" tabIndex={-1} data-focus-target>
        {t("Pair {name}", { name: code.deviceName })}
      </h3>
      <p className="hint">{t("On the counter phone, scan this code with the camera, or open the counter app and type the code.")}</p>
      <img src={qr} alt={t("QR code to pair {name}", { name: code.deviceName })} width={200} height={200} />
      <p className="code" dir="ltr">
        <span aria-hidden="true">{code.code}</span>
        <span className="visually-hidden">{t("Pairing code, letter by letter: {letters}", { letters: Array.from(code.code.replace(/-/g, "")).join(" ") })}</span>
      </p>
      <p>{t("It works once, until {time}. It is not shown again.", { time: dateFormat(lang, { timeStyle: "short" }).format(new Date(code.expiresAt)) })}</p>
      <button type="button" className="primary" onClick={onDone}>
        {t("Done")}
      </button>
    </section>
  );
}

function PairForm({ onCreated }: { onCreated: (code: PairingCode) => void }) {
  const t = useT(AR);
  const [deviceName, setDeviceName] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="pair-title"
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(() => apiRequest("POST", "/api/devices/pairing-codes", pairingCodeSchema, { deviceName })).then((result) => {
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
      <button type="submit" disabled={pending}>
        {pending ? t("Creating…") : t("Create pairing code")}
      </button>
    </form>
  );
}

/** `/devices`: paired counter phones, open pairing codes and revocation (AC 17, 21). */
export function DevicesPage() {
  const t = useT(AR);
  const lang = useLang();
  const [reload, setReload] = useState(0);
  const [state, setDevices] = useApiData("/api/devices", devicesSchema, reload);
  const [newCode, setNewCode] = useState<PairingCode | null>(null);
  const [notice, setNotice] = useState<Later<typeof AR> | null>(null);
  const { pending, error, submit } = useSubmit();
  const pairing = useFocusOnChange<HTMLDivElement>(newCode === null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const devices: Devices = state.data;
  const timeFormat = dateFormat(lang, { dateStyle: "medium", timeStyle: "short" });
  const clockFormat = dateFormat(lang, { timeStyle: "short" });

  return (
    <section aria-labelledby="devices-page-title">
      <h2 id="devices-page-title" tabIndex={-1} data-focus-after-change>
        {t("Devices")}
      </h2>
      <p className="page-intro">{t("The phones and tablets your baristas record visits on. Pair a new one with a one-time code; remove one that is lost.")}</p>
      {notice === null ? null : <Notice>{notice(t, lang)}</Notice>}
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
            code={newCode}
            onDone={() => {
              setNewCode(null);
              setReload((value) => value + 1);
            }}
          />
        )}
      </div>
      <h3>{t("Counter phones")}</h3>
      {devices.devices.length === 0 ? (
        <p className="empty">{t("No phones paired yet. Pair one above to start recording visits at the counter.")}</p>
      ) : (
        <ul className="items">
          {devices.devices.map((device) => (
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
          ))}
        </ul>
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
                  disabled={pending}
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
