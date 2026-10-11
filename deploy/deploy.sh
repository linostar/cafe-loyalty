#!/usr/bin/env bash
# Deploys a release to one environment (AC 52, 53; README, Deploying): `deploy.sh <production|staging> <commit>
# <digest>`, as root (the release workflow runs it as the deploy user through sudo). Pulls the release image by digest
# (it must be that commit's, and at or after the running release), makes the encrypted pre-deploy backup, bootstraps the database (roles, a no-op once made)
# and runs the release's migrations in one-off containers: expand migrations, and a contract migration only once the
# running release is at or after its requires-deployed commit (AC 47), otherwise nothing is migrated or restarted.
# Then restarts the server and worker on the release, waits for the server's readiness and switches the dashboard and
# counter builds Caddy serves. If the release does not get ready, the previous recorded release runs again on the same
# schema (no migration is undone) and the script fails.
set -euo pipefail

SCRIPT=deploy
# shellcheck source=deploy/release-common.sh source-path=SCRIPTDIR
. "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"

usage="usage: deploy.sh <production|staging> <commit (40 hex)> <image digest (sha256:…)>"
[[ $# -eq 3 && ($1 == production || $1 == staging) ]] || fail "$usage"
commit=$2 digest=$3
[[ $commit =~ ^[0-9a-f]{40}$ && $digest =~ ^sha256:[0-9a-f]{64}$ ]] || fail "$usage"
load_environment "$1"
image=$repo@$digest

log "deploying $commit to $env."
ensure_image "$commit" "$digest"
previous=$(current_release)
if [[ -n $previous ]]; then
  ensure_image "${previous% *}" "${previous#* }"
  running_commits=$(release_commits "$repo@${previous#* }")
  # A deploy moves forward: an older release (a rerun of an old workflow, a stale approval) never replaces a newer one
  # silently. Going back is rollback.sh's.
  grep -qx "${previous% *}" <<<"$(release_commits "$image")" ||
    fail "$commit is not at or after the running ${previous% *}, so nothing was deployed; to go back, use rollback.sh."
fi

# Before anything changes; backup.sh skips an environment never deployed.
"/opt/$APP/bin/backup.sh" "$env" predeploy || fail "the pre-deploy backup failed, so nothing was deployed."
compose "$image" up -d --wait --wait-timeout 300 postgres || fail "the $env PostgreSQL did not start."
if ! compose "$image" run --rm -T bootstrap </dev/null; then
  record failed "$commit" "$digest"
  fail "the database bootstrap failed (above), so nothing was deployed."
fi
if [[ -n $previous ]]; then
  migrated=0
  compose "$image" run --rm -T -e MIGRATE_MODE=expand migrate <<<"$running_commits" || migrated=$?
else
  # The first deploy: no release runs that a contract migration could break.
  migrated=0
  compose "$image" run --rm -T migrate </dev/null || migrated=$?
fi
if ((migrated != 0)); then
  record failed "$commit" "$digest"
  fail "the migrations failed or were refused (above), so nothing was restarted${previous:+: $env still runs ${previous% *}}."
fi

if start_release "$commit" "$digest"; then
  record deploy "$commit" "$digest"
  prune_releases
  exit 0
fi
record failed "$commit" "$digest"
report_state "$image"
[[ -n $previous ]] || fail "$commit did not get ready, and $env has no previous release to go back to."
log "going back to ${previous% *} on the same schema."
if start_release "${previous% *}" "${previous#* }"; then
  record fallback "${previous% *}" "${previous#* }"
  fail "$commit did not get ready, so $env is back on ${previous% *}."
fi
report_state "$repo@${previous#* }"
fail "$commit did not get ready, and neither did ${previous% *} after it: $env is down."
