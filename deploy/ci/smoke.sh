#!/usr/bin/env bash
# Smoke tests of an environment from outside, through Caddy and TLS, for the release workflow (AC 51): `smoke.sh
# <public URL> <dashboard URL> <counter URL> [<commit>]`. The API is ready (database and job queue), the dashboard and
# counter domains serve their apps with the Content-Security-Policy and reach the API, the counter's service worker is
# revalidated on every load, and, with a commit, the counter build is that release's.
set -euo pipefail

fail() {
  echo "::error title=Smoke test failed::$*"
  exit 1
}
(($# == 3 || $# == 4)) || fail "usage: smoke.sh <public URL> <dashboard URL> <counter URL> [<commit>]"
public=${1%/} dashboard=${2%/} counter=${3%/} commit=${4:-}
# Retried: Caddy may still be loading a certificate, and a release only just went live.
fetch() { curl -fsS --max-time 15 --retry 5 --retry-delay 3 --retry-all-errors "$@"; }
status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1" || true; }

ready=$(fetch "$public/health/ready") || fail "$public/health/ready did not answer 200."
# One line, at most 200 characters: the response goes into the public workflow log.
[[ $ready == *'"status":"ready"'* ]] || fail "$public/health/ready says: $(tr -cd '[:alnum:] {}":,_-' <<<"$ready" | cut -c1-200)"
for app in "$dashboard" "$counter"; do
  headers=$(fetch -o /dev/null -D - "$app/") || fail "$app/ did not answer 200."
  grep -qi '^content-security-policy: ' <<<"$headers" || fail "$app/ has no Content-Security-Policy."
  [[ $(status_of "$app/api/cafe") == 401 ]] || fail "$app/api/cafe did not answer 401 (signed out): /api does not reach the server."
done
worker_headers=$(mktemp)
trap 'rm -f "$worker_headers"' EXIT
worker=$(fetch -D "$worker_headers" "$counter/sw.js") || fail "$counter/sw.js did not answer 200."
grep -qi '^cache-control: no-cache' "$worker_headers" || fail "$counter/sw.js is not sent with Cache-Control: no-cache."
[[ -z $commit || $worker == *"counter-$commit-"* ]] || fail "$counter serves another release's counter than $commit."
echo "Smoke tests passed: $public, $dashboard, $counter${commit:+ (release $commit)}."
