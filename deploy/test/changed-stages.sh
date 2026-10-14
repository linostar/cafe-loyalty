#!/usr/bin/env bash
# Tests CI's stage filter, deploy/ci/changed-stages.sh (`pnpm test:deploy`, part of `pnpm test`; needs only git): in a
# throwaway repository, each case commits its paths on a branch from one base commit and checks the stages the filter
# picks against that base, then the cases where it must run everything (a rename out of a stage's paths, a base it
# cannot diff against, no base).
set -euo pipefail

FILTER=$(cd "$(dirname "${BASH_SOURCE[0]}")/../ci" && pwd)/changed-stages.sh
readonly FILTER
REPO=$(mktemp -d)
readonly REPO
trap 'rm -rf "$REPO"' EXIT

failures=0
git_() { git -C "$REPO" -c user.name=Test -c user.email=test@example.test -c commit.gpgsign=false "$@"; }

git_ init -q -b main
mkdir -p "$REPO/apps/server/src"
echo base >"$REPO/apps/server/src/kept.ts"
git_ add -A
git_ commit -q -m base

# expect <db> <deploy> <e2e> <what it runs> -- <base ref>
expect() {
  local want="db=$1 deploy=$2 e2e=$3" name=$4 base=$6 got
  got=$(cd "$REPO" && bash "$FILTER" "$base" | paste -sd ' ' -)
  if [[ $got == "$want" ]]; then
    echo "ok: $name"
  else
    echo "FAIL: $name: got '$got', want '$want'"
    failures=$((failures + 1))
  fi
}

# check <db> <deploy> <e2e> <path>...: a branch from the base commit that adds or changes these paths.
check() {
  local db=$1 deploy=$2 e2e=$3 path
  shift 3
  git_ checkout -q -B case main
  for path in "$@"; do
    mkdir -p "$(dirname "$REPO/$path")"
    echo changed >>"$REPO/$path"
  done
  git_ add -A
  git_ commit -q -m case
  expect "$db" "$deploy" "$e2e" "$(printf '%q ' "$@")" -- main
}

check false false false README.md
check false false false README.md .claude/notes.md
check false false true apps/dashboard/src/App.tsx
check false false true apps/counter/src/sync.ts
check false false true e2e/dashboard/admin.spec.ts
check false false true playwright.config.ts
check true true true packages/ui/src/fonts.css
check true true true packages/shared/src/brand.ts
check true true true packages/db/migrations/0099_test.sql
check true true true apps/server/src/admin-routes.ts
check true true true apps/worker/src/jobs.ts
check true false false vitest.integration.config.ts
check false true false deploy/backup.sh
check false true false deploy/test/deploy.sh
check false true false Dockerfile
check false true false .dockerignore
check false true false compose.dev.yaml
check false true false tsconfig.json
check false true true deploy/spa-csp.txt
check true true true .github/workflows/ci.yml
check true true true deploy/ci/changed-stages.sh
check true true true pnpm-lock.yaml
check true true true package.json
check true true true pnpm-workspace.yaml
check true true true packages/db/package.json
check true true true apps/dashboard/package.json
check true true true .nvmrc
check true true true tsconfig.base.json
# Names git would quote in line output: a tab, a quote, a backslash, a newline and a non-ASCII letter.
check false false true $'e2e/dashboard/tab\there.spec.ts'
check false false true 'e2e/dashboard/quote".spec.ts'
check false false true 'e2e/dashboard/back\slash.spec.ts'
check false false true $'e2e/dashboard/new\nline.spec.ts'
check false false true 'apps/dashboard/src/café.tsx'

# A rename out of a stage's paths still runs that stage (both sides count).
git_ checkout -q -B case main
mkdir -p "$REPO/docs"
git_ mv apps/server/src/kept.ts docs/kept.ts
git_ commit -q -m case
expect true true true "rename out of apps/server" -- main
# Nothing to diff against: everything runs.
expect true true true "a base ref that does not exist" -- origin/missing
expect true true true "no base ref (a push to main)" -- ""

if ((failures > 0)); then
  echo "$failures stage filter check(s) failed."
  exit 1
fi
echo "All stage filter checks passed."
