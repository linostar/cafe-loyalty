import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Form, useSubmit } from "./forms.js";

/** Whether leaving the page now would ask first. */
function leavingAsks(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** A form whose save waits for `finish` and fails when `fail` is set; `keepOnReset` cancels its reset; `clears` empties it once saved. */
function NameForm({ control, keepOnReset = false, clears = false }: { control: { finish?: () => void; fail: boolean }; keepOnReset?: boolean; clears?: boolean }) {
  const [name, setName] = useState("");
  const { submit } = useSubmit();
  return (
    <Form
      onReset={(event) => {
        if (keepOnReset) {
          event.preventDefault();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit(
          () =>
            new Promise<void>((resolve, reject) => {
              control.finish = () => {
                if (control.fail) {
                  reject(new Error("Fake failure"));
                } else {
                  resolve();
                }
              };
            }),
          { clearsForm: clears },
        ).then((result) => {
          if (result.ok && clears) {
            setName("");
          }
        });
      }}
    >
      <label htmlFor="name">Name</label>
      <input
        id="name"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <button type="submit">Save</button>
      <button type="reset">Reset</button>
    </Form>
  );
}

const finish = async (control: { finish?: () => void }) => {
  await act(async () => {
    control.finish?.();
    await Promise.resolve();
  });
};

describe("unsaved changes in a Form", () => {
  it("asks before leaving once something is typed, until a save succeeds", async () => {
    const control: { finish?: () => void; fail: boolean } = { fail: true };
    render(<NameForm control={control} />);
    expect(leavingAsks()).toBe(false);
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Café Najjar" } });
    expect(leavingAsks()).toBe(true);
    // A failed save keeps the changes unsaved.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await finish(control);
    expect(leavingAsks()).toBe(true);
    control.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await finish(control);
    await waitFor(() => {
      expect(leavingAsks()).toBe(false);
    });
  });

  it("keeps asking when the form was edited while its save was on its way, and stops on a reset", async () => {
    const control: { finish?: () => void; fail: boolean } = { fail: false };
    render(<NameForm control={control} />);
    const input = screen.getByLabelText("Name");
    fireEvent.input(input, { target: { value: "Café" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.input(input, { target: { value: "Café Najjar" } });
    await finish(control);
    expect(leavingAsks()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(leavingAsks()).toBe(false);
  });

  it("stops asking when a save empties the form, though it was edited while the save was on its way", async () => {
    const control: { finish?: () => void; fail: boolean } = { fail: false };
    render(<NameForm control={control} clears />);
    const input = screen.getByLabelText("Name");
    fireEvent.input(input, { target: { value: "Café" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.input(input, { target: { value: "Café Najjar" } });
    await finish(control);
    await waitFor(() => {
      expect(input).toHaveValue("");
    });
    expect(leavingAsks()).toBe(false);
  });

  it("keeps asking when the reset is cancelled", () => {
    render(<NameForm control={{ fail: false }} keepOnReset />);
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Café" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(leavingAsks()).toBe(true);
  });

  it("stops asking once the form is gone", () => {
    const { unmount } = render(<NameForm control={{ fail: false }} />);
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Café" } });
    expect(leavingAsks()).toBe(true);
    unmount();
    expect(leavingAsks()).toBe(false);
  });
});
