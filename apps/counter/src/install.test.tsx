import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LangProvider } from "./i18n.js";
import { InstallHint } from "./install.js";

const show = () =>
  render(
    <LangProvider>
      <InstallHint />
    </LangProvider>,
  );

describe("InstallHint", () => {
  it("says nothing once the counter is opened from the home screen", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(display-mode: standalone)" }));
    const { container } = show();
    expect(container).toBeEmptyDOMElement();
  });

  it("gives Safari's Share steps on an iPhone, which has no install offer", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
    show();
    expect(screen.getByText("To open the counter from the home screen next time: in Safari, tap Share, then Add to Home Screen.")).toBeInTheDocument();
  });

  it("names the counter's address to bookmark in a browser without an install offer", () => {
    show();
    expect(screen.getByText(`To find the counter next time, add it to the home screen from the browser's menu, or bookmark ${window.location.host}.`)).toBeInTheDocument();
  });
});
