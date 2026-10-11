#!/usr/bin/env bash
# Runs a recorded release again in one environment (AC 54; README, Deploying): `rollback.sh <production|staging>
# [<commit>]`, as root (or the deploy user through sudo). Without a commit, the release that ran before the current one.
# The schema stays as it is (releases only expand it, so an older release runs on it), but a release from before a
# contract migration the database has is refused: what that migration removed, the release still uses. Restarts the
# server and worker, waits for readiness and switches the web builds like deploy.sh; if the release does not get
# ready, the current one runs again. Exits 3, changing nothing, when no other release ever ran (the release workflow's
# rollback test skips then).
set -euo pipefail

SCRIPT=rollback
# shellcheck source=deploy/release-common.sh source-path=SCRIPTDIR
. "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"

usage="usage: rollback.sh <production|staging> [<commit (40 hex), a release recorded in releases.log>]"
[[ ($# -eq 1 || $# -eq 2) && ($1 == production || $1 == staging) ]] || fail "$usage"
[[ $# -eq 1 || $2 =~ ^[0-9a-f]{40}$ ]] || fail "$usage"
load_environment "$1"

current=$(current_release)
[[ -n $current ]] || fail "$env has no release yet; deploy one with deploy.sh."
if [[ $# -eq 2 ]]; then
  target=$(ran_releases | awk -v commit="$2" '$1 == commit' | tail -n 1)
  [[ -n $target ]] || fail "$2 never ran in $env (see $releases)."
else
  target=$(ran_releases | awk -v commit="${current% *}" '$1 != commit' | tail -n 1)
  if [[ -z $target ]]; then
    log "$env has run no other release than ${current% *}."
    exit 3
  fi
fi
commit=${target% *} digest=${target#* }
[[ $commit != "${current% *}" ]] || fail "$env already runs $commit."
image=$repo@$digest

log "rolling $env back from ${current% *} to $commit."
ensure_image "$commit" "$digest"
postgres=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=postgres)
[[ -n $postgres && $postgres != *$'\n'* ]] || fail "the $env PostgreSQL container is not running."
PGPASSWORD=$(env_value "$dir/database.env" POSTGRES_PASSWORD)
export PGPASSWORD
required=$(docker exec -e PGPASSWORD "$postgres" psql -X -At -h localhost -U "$(env_value "$dir/database.env" POSTGRES_USER)" \
  -d "$(env_value "$dir/database.env" DATABASE_NAME)" -c \
  "SELECT requires_deployed FROM meta.schema_migrations WHERE requires_deployed IS NOT NULL") ||
  fail "cannot read the $env database's contract migrations."
if [[ -n $required ]]; then
  commits=$(release_commits "$image")
  while read -r needed; do
    grep -qx "$needed" <<<"$commits" ||
      fail "$commit is from before $needed, which a contract migration the database has requires: it would not run on this schema."
  done <<<"$required"
fi

if start_release "$commit" "$digest"; then
  record rollback "$commit" "$digest"
  exit 0
fi
record failed "$commit" "$digest"
report_state "$image"
log "going back to ${current% *}."
if start_release "${current% *}" "${current#* }"; then
  record fallback "${current% *}" "${current#* }"
  fail "$commit did not get ready, so $env is back on ${current% *}."
fi
report_state "$repo@${current#* }"
fail "$commit did not get ready, and neither did ${current% *} after it: $env is down."
