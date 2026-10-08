import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";

describe("Dashboard App", () => {
  it("shows the heading and build id", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Cafe Loyalty Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Build test-build")).toBeInTheDocument();
  });
});
