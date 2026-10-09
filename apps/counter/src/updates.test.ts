import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useServiceWorkerUpdate } from "./updates.js";

/** A browser's service worker container with a new build installed and waiting. */
function stubWaitingUpdate() {
  const postMessage = vi.fn();
  const registration = { waiting: { postMessage }, installing: null, addEventListener: vi.fn(), update: vi.fn(() => Promise.resolve()) };
  const container = { register: vi.fn(() => Promise.resolve(registration)), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  return { postMessage, container };
}

describe("useServiceWorkerUpdate", () => {
  it("switches to a waiting build only once the counter is idle (AC 29)", async () => {
    const { postMessage, container } = stubWaitingUpdate();
    const { result, rerender } = renderHook(({ idle }) => useServiceWorkerUpdate(idle, true), { initialProps: { idle: false } });
    await waitFor(() => {
      expect(result.current.waiting).toBe(true);
    });
    expect(container.register).toHaveBeenCalledWith("/sw.js");
    expect(postMessage).not.toHaveBeenCalled();
    act(() => {
      rerender({ idle: true });
    });
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(container.addEventListener).toHaveBeenCalledWith("controllerchange", expect.any(Function));
  });

  it("says when offline use is unavailable", async () => {
    stubWaitingUpdate().container.register.mockImplementation(() => Promise.reject(new Error("blocked")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useServiceWorkerUpdate(true, true));
    await waitFor(() => {
      expect(result.current.error).toMatch(/could not be saved for offline use/);
    });
  });
});
