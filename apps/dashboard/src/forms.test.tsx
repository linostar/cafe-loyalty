import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Field, Form } from "./forms.js";

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

  it("shows the password without sending its form", () => {
    const onSubmit = vi.fn();
    render(
      <Form aria-label="Sign in" onSubmit={onSubmit}>
        <Field label="Password" name="password" type="password" value="secret-test" onChange={() => undefined} />
      </Form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("has no toggle on other fields", () => {
    render(<Field label="Name" name="name" type="text" value="" onChange={() => undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
