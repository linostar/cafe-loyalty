import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { addQueued, getMeta, setMeta, settleQueued } from "./storage.js";
import { CAFE, envelope, fakeApi, staffEntry, storePairedDevice, type ApiCall, type FakeReply } from "./test-helpers.js";

const RAMI_ID = "2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e";
const PAIRED = {
  deviceId: "7e57d3c1-0000-4000-8000-000000000001",
  keyId: "7e57d3c1-0000-4000-8000-000000000002",
  deviceName: "Front counter",
  cafe: CAFE,
  accessToken: "t".repeat(43),
  accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
};

function setOnline(value: boolean): void {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(value);
}

/** The API a working counter sees: pairing, staff and sync, with `override` answering first. */
async function workingApi(override: (call: ApiCall) => FakeReply | undefined = () => undefined): Promise<ApiCall[]> {
  const rami = await staffEntry(RAMI_ID, "Rami", "482913");
  return fakeApi((call) => {
    const answer = override(call);
    if (answer !== undefined) {
      return answer;
    }
    switch (call.path) {
      case "/api/device/pair":
        return { status: 201, body: PAIRED };
      case "/api/device/staff":
        return { status: 200, body: { staff: [rami] } };
      case "/api/device/sync": {
        const events = (call.body as { events: unknown[] }).events;
        return { status: 200, body: { results: events.map((_, index) => ({ index, eventId: null, status: "applied", code: "OK" })) } };
      }
      default:
        return { status: 404, body: envelope("NOT_FOUND") };
    }
  });
}

async function enterPin(pin: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText("PIN"), { target: { value: pin } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("Counter App", () => {
  it("always shows connectivity, what waits to be sent, and the build (AC 29)", async () => {
    setOnline(true);
    window.history.replaceState(null, "", "/");
    fakeApi(() => ({ status: 404, body: envelope("NOT_FOUND") }));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Pair this phone" })).toBeInTheDocument();
    expect(screen.getByText("Build test-build")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Online");
    expect(screen.getByText("Nothing waiting to send.")).toBeInTheDocument();

    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toHaveTextContent(/^Offline/);
    await act(() => addQueued({ sequence: 1, eventId: "e1", type: "visit.recorded", occurredAt: "2026-10-01T08:00:00.000Z", event: {} }));
    expect(await screen.findByText("1 waiting to send.")).toBeInTheDocument();
  });

  it("pairs from the dashboard's link, then signs a barista in by name and PIN until switched", async () => {
    setOnline(true);
    window.history.replaceState(null, "", "/pair#code=ABCD-1234-EFGH");
    const calls = await workingApi();
    render(<App />);
    expect(await screen.findByLabelText("Pairing code")).toHaveValue("ABCD-1234-EFGH");
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Pair this phone" }));

    fireEvent.click(await screen.findByRole("button", { name: "Rami" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "PIN for Rami" })).toHaveFocus();
    });
    await enterPin("111111");
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong PIN. 4 tries left before a pause.");
    await enterPin("482913");
    expect(await screen.findByRole("heading", { name: CAFE.name })).toBeInTheDocument();
    expect(screen.getByText("Rami")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(calls.find((call) => call.path === "/api/device/pair")?.body).toMatchObject({ code: "ABCD1234EFGH" });

    fireEvent.click(screen.getByRole("button", { name: "Switch barista" }));
    expect(await screen.findByRole("heading", { name: "Who is working?" })).toBeInTheDocument();
  });

  it("asks before pairing a phone with another café discards what it still has to send there", async () => {
    setOnline(false);
    window.history.replaceState(null, "", "/pair");
    await storePairedDevice({ paired: false, unpairedReason: "pairing_required", cafe: { id: "0f0f0f0f-0000-4000-8000-000000000000", name: "Elsewhere" } });
    await addQueued({ sequence: 1, eventId: "e1", type: "visit.recorded", occurredAt: "2026-10-01T08:00:00.000Z", event: {} });
    await workingApi((call) =>
      call.path === "/api/device/pair" && (call.body as { previous?: unknown }).previous !== undefined ? { status: 409, body: envelope("PAIRED_ELSEWHERE") } : undefined,
    );
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Pairing code"), { target: { value: "ABCD-1234-EFGH" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair this phone" }));
    expect(await screen.findByText(/still paired with Elsewhere and has 1 item waiting to send there/)).toBeInTheDocument();
    expect(await getMeta("device")).toMatchObject({ cafe: { name: "Elsewhere" } });
    fireEvent.click(screen.getByRole("button", { name: "Start over and discard it" }));
    expect(await screen.findByRole("heading", { name: "Who is working?" })).toBeInTheDocument();
    expect(await getMeta("device")).toMatchObject({ cafe: CAFE, paired: true });
    expect(screen.getByText("Nothing waiting to send.")).toBeInTheDocument();
  });

  it("explains a code that is not 12 characters without calling the server", async () => {
    setOnline(true);
    window.history.replaceState(null, "", "/");
    const calls = await workingApi();
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Pairing code"), { target: { value: "ABC" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair this phone" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the 12-character code shown on the owner's dashboard.");
    expect(calls).toHaveLength(0);
  });

  it("goes back to pairing when the owner removed the phone, forgetting the PIN hashes (AC 21)", async () => {
    setOnline(true);
    window.history.replaceState(null, "", "/");
    await storePairedDevice();
    await setMeta("staff", [await staffEntry(RAMI_ID, "Rami", "482913")]);
    await workingApi((call) => (call.path === "/api/device/staff" ? { status: 401, body: envelope("DEVICE_REVOKED") } : undefined));
    render(<App />);
    expect(await screen.findByText(/The owner removed this phone/)).toBeInTheDocument();
    expect(await getMeta("staff")).toBeUndefined();
  });

  it("signs out a barista the owner removed", async () => {
    setOnline(true);
    window.history.replaceState(null, "", "/");
    await storePairedDevice();
    const linaId = "0c0c0c0c-0000-4000-8000-000000000000";
    await setMeta("staff", [await staffEntry(linaId, "Lina", "205871")]);
    await setMeta("barista", { staffId: linaId });
    await workingApi();
    render(<App />);
    expect(await screen.findByRole("button", { name: "Rami" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Who is working?" })).toBeInTheDocument();
    expect(await getMeta("barista")).toBeUndefined();
  });

  it("lists events the server refused until someone clears them (AC 23)", async () => {
    setOnline(false);
    window.history.replaceState(null, "", "/");
    fakeApi(() => ({ status: 404, body: envelope("NOT_FOUND") }));
    await settleQueued(
      [],
      [
        { eventId: "e1", type: "visit.recorded", occurredAt: "2026-10-01T08:00:00.000Z", code: "CLOCK_SKEW", rejectedAt: "2026-10-01T08:05:00.000Z" },
        { eventId: "e2", type: "visit.recorded", occurredAt: "2026-10-01T08:10:00.000Z", code: "PHONE_NOT_CONFIRMED", rejectedAt: "2026-10-01T08:15:00.000Z" },
      ],
    );
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Not accepted by the server" })).toBeInTheDocument();
    expect(screen.getByText(/Visit from .*: the phone's clock was wrong/)).toBeInTheDocument();
    expect(screen.getByText(/Visit from .*: this number is not confirmed yet; scan the customer's card once/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear list" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Not accepted by the server" })).not.toBeInTheDocument();
    });
  });

  it("says so when the server no longer serves this build (AC 26)", async () => {
    setOnline(true);
    window.history.replaceState(null, "", "/");
    await storePairedDevice();
    await workingApi((call) =>
      call.path === "/api/device/staff" ? { status: 426, body: envelope("CLIENT_TOO_OLD", "This counter app is out of date.") } : undefined,
    );
    render(<App />);
    expect(await screen.findByText("This counter app is out of date.")).toBeInTheDocument();
  });
});
