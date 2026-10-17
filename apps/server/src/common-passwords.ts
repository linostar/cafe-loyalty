import { ApiError, apiText } from "@cafe-loyalty/shared";
import { readFileSync } from "node:fs";

/** Compared after NFKC and lower-casing, so "QWERTYUIOP" or a full-width "１２３４５６７８９０" counts as listed. */
const normalise = (value: string): string => value.normalize("NFKC").toLowerCase();

/** SecLists' common passwords that pass the length rule (apps/server/assets/common-passwords/README.md). Server only. */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  readFileSync(new URL("../assets/common-passwords/common-passwords.txt", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map(normalise),
);

export const isCommonPassword = (password: string): boolean => COMMON_PASSWORDS.has(normalise(password));

/** Refuses a new password found in the list, as a field issue in the same envelope parseInput sends. */
export function refuseCommonPassword(password: string, path: string): void {
  if (isCommonPassword(password)) {
    throw new ApiError("VALIDATION_FAILED", apiText("Some fields are missing or not valid. Check them and try again."), [
      { path, issue: apiText("This password is too common. Choose another.") },
    ]);
  }
}
