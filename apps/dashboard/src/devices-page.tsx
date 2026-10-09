import { devicesSchema, pairingCodeSchema, type Devices, type PairingCode } from "@cafe-loyalty/shared";
import { useState } from "react";
import { renderSVG } from "uqr";
import { apiRequest, isStale, noContent } from "./api.js";
import { ConfirmButton, Field, FormError, Notice, useFocusOnChange, useSubmit } from "./forms.js";
import { PageStatus, useApiData } from "./session.js";

const timeFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });
const clockFormat = new Intl.DateTimeFormat("en-GB", { timeStyle: "short" });

/** The new code, shown once: as text to type and as a QR that opens the counter app's pairing page (AC 17). */
function NewCode({ code, onDone }: { code: PairingCode; onDone: () => void }) {
  // A 4-module quiet zone, as the QR specification asks, so phone cameras read it reliably.
  const qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSVG(code.pairingUrl, { border: 4 }))}`;
  return (
    <section aria-labelledby="new-code-title" className="new-code">
      <h3 id="new-code-title" tabIndex={-1} data-focus-target>
        Pair {code.deviceName}
      </h3>
      <p>On the counter phone, scan this code with the camera, or open the counter app and type the code.</p>
      <img src={qr} alt={`QR code to pair ${code.deviceName}`} width={200} height={200} />
      <p className="code">
        <span aria-hidden="true">{code.code}</span>
        <span className="visually-hidden">Pairing code, letter by letter: {Array.from(code.code.replace(/-/g, "")).join(" ")}</span>
      </p>
      <p>It works once, until {clockFormat.format(new Date(code.expiresAt))}. It is not shown again.</p>
      <button type="button" onClick={onDone}>
        Done
      </button>
    </section>
  );
}

function PairForm({ onCreated }: { onCreated: (code: PairingCode) => void }) {
  const [deviceName, setDeviceName] = useState("");
  const { pending, error, fieldErrors, submit } = useSubmit();
  return (
    <form
      aria-labelledby="pair-title"
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
      <h3 id="pair-title">Pair a counter phone</h3>
      <FormError message={error} />
      <Field
        label="Phone name"
        name="deviceName"
        type="text"
        autoComplete="off"
        value={deviceName}
        onChange={setDeviceName}
        maxLength={60}
        hint="So you can tell the phones apart, such as Front counter."
        error={fieldErrors.deviceName}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create pairing code"}
      </button>
    </form>
  );
}

/** `/devices`: paired counter phones, open pairing codes and revocation (AC 17, 21). */
export function DevicesPage() {
  const [reload, setReload] = useState(0);
  const [state, setDevices] = useApiData("/api/devices", devicesSchema, reload);
  const [newCode, setNewCode] = useState<PairingCode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { pending, error, submit } = useSubmit();
  const pairing = useFocusOnChange<HTMLDivElement>(newCode === null);
  if (state.status !== "loaded") {
    return <PageStatus state={state} />;
  }
  const devices: Devices = state.data;

  return (
    <section aria-labelledby="devices-page-title">
      <h2 id="devices-page-title" tabIndex={-1} data-focus-after-change>
        Devices
      </h2>
      {notice === null ? null : <Notice>{notice}</Notice>}
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
      <h3>Counter phones</h3>
      {devices.devices.length === 0 ? (
        <p>No phones paired yet.</p>
      ) : (
        <ul className="items">
          {devices.devices.map((device) => (
            <li key={device.id}>
              <strong>{device.name}</strong>
              {device.revoked ? " · removed" : ` · last seen ${timeFormat.format(new Date(device.lastSeenAt))}`}{" "}
              {device.revoked ? null : (
                <ConfirmButton
                  label={`Remove ${device.name}`}
                  confirmLabel={`Yes, remove ${device.name}`}
                  pending={pending}
                  onConfirm={() => {
                    void submit(() => apiRequest("POST", `/api/devices/${device.id}/revoke`, devicesSchema)).then((result) => {
                      if (result.ok) {
                        setDevices(result.value);
                        setNotice(`${device.name} is removed. It stops working the next time it connects; anything it had not sent waits under Review.`);
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
          <h3>Open pairing codes</h3>
          <ul className="items">
            {devices.pairingCodes.map((code) => (
              <li key={code.id}>
                {code.deviceName} · until {clockFormat.format(new Date(code.expiresAt))}{" "}
                <button
                  type="button"
                  disabled={pending}
                  aria-label={`Cancel code for ${code.deviceName}`}
                  onClick={() => {
                    void submit(() => apiRequest("DELETE", `/api/devices/pairing-codes/${code.id}`, noContent)).then((result) => {
                      if (result.ok || isStale(result.error)) {
                        setReload((value) => value + 1);
                      }
                    });
                  }}
                >
                  Cancel code
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
