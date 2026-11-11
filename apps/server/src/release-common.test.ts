import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const RELEASE_COMMON = fileURLToPath(new URL("../../../deploy/release-common.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "release-common-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** `kept_releases` on the given logs, under the options deploy.sh and rollback.sh set: its output, or the exit status. */
function keptReleases(...logs: string[]): string[] {
  const script = `set -euo pipefail; source "$1"; shift; kept=$(kept_releases "$@"); printf '%s\\n' "$kept"`;
  return execFileSync("bash", ["-c", script, "bash", RELEASE_COMMON, ...logs], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\n")
    .filter((line) => line !== "");
}

const line = (n: number, what = "deploy") => `2026-11-10T00:00:00Z ${what} c${String(n)} sha256:d${String(n)}`;

// The VPS's (and CI's) GNU coreutils; macOS has no tac, so a Mac skips these.
const hasTac = spawnSync("tac", ["--version"]).status === 0;

describe.skipIf(!hasTac)("kept_releases (deploy/release-common.sh)", () => {
  it("keeps the last 5 releases that ran, newest first, once each, failed ones aside", () => {
    const log = join(dir, "small.log");
    writeFileSync(log, [line(1), line(2), line(3), line(4, "failed"), line(5), line(6), line(7), line(6, "rollback"), ""].join("\n"));
    expect(keptReleases(log)).toEqual(["c6 sha256:d6", "c7 sha256:d7", "c5 sha256:d5", "c3 sha256:d3", "c2 sha256:d2"]);
  });

  it("reads a long history to the end, so pipefail never stops the deploy with a SIGPIPE", () => {
    // Far more than a pipe holds: a pipeline that stopped reading after 5 lines would make its writer exit 141.
    const log = join(dir, "long.log");
    writeFileSync(log, `${Array.from({ length: 50_000 }, (_, n) => line(n)).join("\n")}\n`);
    expect(keptReleases(log, join(dir, "missing.log"))).toEqual(["c49999 sha256:d49999", "c49998 sha256:d49998", "c49997 sha256:d49997", "c49996 sha256:d49996", "c49995 sha256:d49995"]);
  });

  it("gives nothing, and succeeds, for an environment that never ran a release", () => {
    expect(keptReleases(join(dir, "missing.log"))).toEqual([]);
  });
});
