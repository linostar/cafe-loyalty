import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function setOnline(value: boolean): void {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(value);
}

describe("Counter App", () => {
  it("shows the build id", () => {
    setOnline(true);
    render(<App />);
    expect(screen.getByText("Build test-build")).toBeInTheDocument();
  });

  it("announces connectivity changes", () => {
    setOnline(true);
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Online");

    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toHaveTextContent(/^Offline/);

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Online");
  });
});
