import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useServiceWorkerUpdate } from "./updates.js";

interface FakeWorker {
  state: string;
  postMessage: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  /** Moves the worker to `state` and tells its listeners. */
  become: (state: string) => void;
}

function fakeWorker(state: string): FakeWorker {
  const listeners: (() => void)[] = [];
  const worker: FakeWorker = {
    state,
    postMessage: vi.fn(),
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    become: (next) => {
      worker.state = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
  return worker;
}

/** A browser's service worker container whose registration has `installing` and `waiting` workers. */
function stubServiceWorker(workers: { installing?: FakeWorker; waiting?: FakeWorker }, controller: object | null) {
  const registration = {
    installing: workers.installing ?? null,
    waiting: workers.waiting ?? null,
    addEventListener: vi.fn(),
    update: vi.fn(() => Promise.resolve()),
  };
  const container = { controller, register: vi.fn(() => Promise.resolve(registration)), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  return { registration, container };
}

describe("useServiceWorkerUpdate", () => {
  it("switches to a waiting build only once the counter is idle (AC 29)", async () => {
    const waiting = fakeWorker("installed");
    const { container } = stubServiceWorker({ waiting }, {});
    const { result, rerender } = renderHook(({ idle }) => useServiceWorkerUpdate(idle, true), { initialProps: { idle: false } });
    await waitFor(() => {
      expect(result.current.waiting).toBe(true);
    });
    expect(container.register).toHaveBeenCalledWith("/sw.js");
    expect(waiting.postMessage).not.toHaveBeenCalled();
    act(() => {
      rerender({ idle: true });
    });
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(container.addEventListener).toHaveBeenCalledWith("controllerchange", expect.any(Function));
  });

  it("notices a build that was already installing when the page loaded", async () => {
    const installing = fakeWorker("installing");
    const { registration } = stubServiceWorker({ installing }, {});
    const { result } = renderHook(() => useServiceWorkerUpdate(false, true));
    await waitFor(() => {
      expect(registration.addEventListener).toHaveBeenCalled();
    });
    act(() => {
      registration.waiting = installing;
      installing.become("installed");
    });
    expect(result.current.waiting).toBe(true);
  });

  it("says when offline use is unavailable: registration refused or the first install failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubServiceWorker({}, null).container.register.mockImplementation(() => Promise.reject(new Error("blocked")));
    const refused = renderHook(() => useServiceWorkerUpdate(true, true));
    await waitFor(() => {
      expect(refused.result.current.error).toMatch(/could not be saved for offline use/);
    });

    const installing = fakeWorker("installing");
    const { registration } = stubServiceWorker({ installing }, null);
    const failed = renderHook(() => useServiceWorkerUpdate(true, true));
    await waitFor(() => {
      expect(registration.addEventListener).toHaveBeenCalled();
    });
    act(() => {
      installing.become("redundant");
    });
    expect(failed.result.current.error).toMatch(/could not be saved for offline use/);
  });
});
