import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QrScanner, SCAN_TIMEOUT_MS } from "./scanner.js";

/** A camera that opens, with a torch or not; its track records what it was asked. */
function fakeCamera(options: { torch: boolean } | { refuse: string }) {
  const track = {
    stop: vi.fn(),
    getCapabilities: vi.fn(() => ("torch" in options && options.torch ? { torch: true } : {})),
    applyConstraints: vi.fn(() => Promise.resolve()),
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn(() => ("refuse" in options ? Promise.reject(new DOMException("No", options.refuse)) : Promise.resolve(stream)));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  // jsdom plays no video: the preview starts at once.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  return track;
}

function scanner(onTimeout = vi.fn()) {
  render(<QrScanner purpose="customer's card" noCamera="Type the number instead." onScan={vi.fn()} onCancel={vi.fn()} onTimeout={onTimeout} />);
  return onTimeout;
}

describe("QrScanner", () => {
  it("offers the camera's torch for a dark counter, and switches it (K7)", async () => {
    const track = fakeCamera({ torch: true });
    scanner();
    const torch = await screen.findByRole("button", { name: "Torch" });
    expect(torch).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(torch);
    await waitFor(() => {
      expect(torch).toHaveAttribute("aria-pressed", "true");
    });
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
  });

  it("switches the torch off again once it is on", async () => {
    const track = fakeCamera({ torch: true });
    scanner();
    const torch = await screen.findByRole("button", { name: "Torch" });
    fireEvent.click(torch);
    await waitFor(() => {
      expect(torch).toHaveAttribute("aria-pressed", "true");
    });
    fireEvent.click(torch);
    await waitFor(() => {
      expect(torch).toHaveAttribute("aria-pressed", "false");
    });
    expect(track.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: false }] });
  });

  it("takes no second torch tap while the first is switching it, so a double tap does not leave it on", async () => {
    const track = fakeCamera({ torch: true });
    let switched: () => void = () => undefined;
    track.applyConstraints.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          switched = resolve;
        }),
    );
    scanner();
    const torch = await screen.findByRole("button", { name: "Torch" });
    fireEvent.click(torch);
    expect(torch).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(torch);
    expect(track.applyConstraints).toHaveBeenCalledOnce();
    await act(async () => {
      switched();
      await Promise.resolve();
    });
    expect(torch).toHaveAttribute("aria-pressed", "true");
    expect(torch).toHaveAttribute("aria-disabled", "false");
  });

  it("shows no torch on a camera without one", async () => {
    const track = fakeCamera({ torch: false });
    scanner();
    await waitFor(() => {
      expect(track.getCapabilities).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button", { name: "Torch" })).not.toBeInTheDocument();
  });

  it("turns the camera off after a minute without a card (K7)", async () => {
    const track = fakeCamera({ torch: false });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onTimeout = vi.fn();
      const { unmount } = render(<QrScanner purpose="customer's card" noCamera="Type the number instead." onScan={vi.fn()} onCancel={vi.fn()} onTimeout={onTimeout} />);
      // The camera opens first, so its track is there to stop.
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        vi.advanceTimersByTime(SCAN_TIMEOUT_MS - 1);
      });
      expect(onTimeout).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onTimeout).toHaveBeenCalledOnce();
      // The screen that asked closes it, and the camera is let go.
      unmount();
      expect(track.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("points to typing the number when the camera is not allowed, and leaves that on screen", async () => {
    fakeCamera({ refuse: "NotAllowedError" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const onTimeout = scanner();
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole("alert")).toHaveTextContent(/^The camera is not allowed\. Type the number instead\./);
      act(() => {
        vi.advanceTimersByTime(SCAN_TIMEOUT_MS * 2);
      });
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
