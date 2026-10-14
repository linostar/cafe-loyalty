#!/usr/bin/env bash
# Which of CI's path-filtered stages a pull request runs, for ci.yml: `changed-stages.sh [<base ref>]` prints one
# `<stage>=true|false` line per stage (db, deploy, e2e), for $GITHUB_OUTPUT, from the files changed since the merge
# base. Fails open: without a base ref (a push to main), when the diff cannot be computed, or when a change touches
# CI itself or what every stage installs, every stage runs. Static checks and unit tests are not listed: they always run.
set -euo pipefail

stages=(db deploy e2e)

run_all() {
  for stage in "${stages[@]}"; do
    echo "$stage=true"
  done
  exit 0
}

# Changes that can affect any stage: the workflows, this script, and the toolchain and dependencies every job installs.
affects_all() {
  case $1 in
  .github/workflows/* | deploy/ci/changed-stages.sh | package.json | pnpm-lock.yaml | pnpm-workspace.yaml | .nvmrc | tsconfig.base.json | apps/*/package.json | packages/*/package.json) return 0 ;;
  esac
  return 1
}

# Database tests: the packages they import (the server reads the design system's fonts, styles and logo when it
# loads) and their configs.
affects_db() {
  case $1 in
  apps/server/* | apps/worker/* | packages/db/* | packages/shared/* | packages/ui/* | vitest.integration.config.ts) return 0 ;;
  esac
  return 1
}

# Deploy tests: the scripts, the image, the PostgreSQL image backup.sh takes from compose.dev.yaml, the migrations they
# deploy and roll back, and everything the server and worker load when they start in the image. Web app changes are
# left to the browser tests, which build every app as the image does.
affects_deploy() {
  case $1 in
  deploy/* | Dockerfile | .dockerignore | compose.dev.yaml | tsconfig.json | packages/db/* | packages/shared/* | packages/ui/* | apps/server/* | apps/worker/*) return 0 ;;
  esac
  return 1
}

# Browser tests: the apps and packages they build, the specs, and the Content-Security-Policy the preview servers send.
affects_e2e() {
  case $1 in
  apps/* | packages/* | e2e/* | playwright.config.ts | deploy/spa-csp.txt) return 0 ;;
  esac
  return 1
}

base=${1:-}
[[ -n $base ]] || run_all
# NUL-delimited, so no path comes quoted (git quotes tabs, newlines, quotes, backslashes and non-ASCII names in lines),
# and both sides of a rename, so a file moved out of a stage's paths still runs that stage.
changed=$(mktemp)
trap 'rm -f "$changed"' EXIT
git diff -z --name-only --no-renames "$base...HEAD" >"$changed" || run_all

db=false deploy=false e2e=false
while IFS= read -r -d '' file; do
  if affects_all "$file"; then run_all; fi
  if affects_db "$file"; then db=true; fi
  if affects_deploy "$file"; then deploy=true; fi
  if affects_e2e "$file"; then e2e=true; fi
done <"$changed"

echo "db=$db"
echo "deploy=$deploy"
echo "e2e=$e2e"
