import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormError } from "./forms.js";
import { LangProvider, LanguageSwitch, useT } from "./i18n.js";

const AR = { "Signed in as {email}": "مسجّل الدخول باسم {email}" } as const;

function Greeting() {
  const t = useT(AR);
  return <p>{t("Signed in as {email}", { email: "rana@example.com" })}</p>;
}

function renderPage() {
  return render(
    <LangProvider>
      <LanguageSwitch />
      <Greeting />
      <FormError message="Your session has ended. Sign in again." />
    </LangProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the dashboard's language", () => {
  it("follows the browser's languages, right to left in Arabic, with the API's messages translated", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["ar-LB", "en"]);
    renderPage();
    expect(document.documentElement).toHaveAttribute("lang", "ar");
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(screen.getByText("مسجّل الدخول باسم ⁨rana@example.com⁩")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("انتهت جلستك. سجّل الدخول مجدداً.");
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("lang", "en");
  });

  it("switches language and keeps the choice for the next visit", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    const { unmount } = renderPage();
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("Signed in as rana@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "العربية" }));
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(screen.getByRole("alert")).toHaveTextContent("انتهت جلستك");
    unmount();

    renderPage();
    expect(document.documentElement).toHaveAttribute("lang", "ar");
  });

  it("still switches when the browser keeps no site data", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "العربية" }));
    expect(document.documentElement).toHaveAttribute("lang", "ar");
  });
});
