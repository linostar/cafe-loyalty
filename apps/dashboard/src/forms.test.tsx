import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./forms.js";

describe("Field", () => {
  it("lets a password or PIN be shown and hidden again, keeping focus on the toggle (D5)", () => {
    render(<Field label="PIN" name="pin" type="password" value="482913" onChange={() => undefined} />);
    const input = screen.getByLabelText("PIN");
    const toggle = screen.getByRole("button", { name: "Show" });
    expect(input).toHaveAttribute("type", "password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("aria-controls", input.id);
    expect(toggle).toHaveAccessibleDescription("PIN");
    toggle.focus();
    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "password");
  });

  it("has no toggle on other fields", () => {
    render(<Field label="Name" name="name" type="text" value="" onChange={() => undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
