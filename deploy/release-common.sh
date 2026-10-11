#!/usr/bin/env bash
# Shared by deploy.sh and rollback.sh, which source it (README, Deploying); it does nothing on its own. An environment's
# releases are recorded in /srv/cafe-loyalty/<environment>/releases.log, one line each: time (UTC), what happened
# (deploy, rollback, fallback: now running; failed: refused or not ready), commit and image digest.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  echo "release-common.sh is part of deploy.sh and rollback.sh; run one of those." >&2
  exit 1
fi

readonly APP=cafe-loyalty
readonly COMPOSE_FILE=/opt/$APP/compose.yaml
readonly SRV_DIR=/srv/$APP
readonly CONF_DIR=/etc/$APP
# Seconds a restarted server has to become ready (AC 52); a test may shorten it (sudo never passes it on).
readonly READY_TIMEOUT=${RELEASE_READY_TIMEOUT:-120}
# Seconds a restarted worker must then keep running without a restart.
readonly WORKER_SETTLE=10
# Releases whose images and web builds stay on the VPS (the newest recorded); a rollback pulls an older one again.
readonly KEEP_RELEASES=5

fail() {
  echo "$SCRIPT: $*" >&2
  exit 1
}
log() { echo "$SCRIPT: $*"; }

# The value of setting $2 in env file $1 (empty when unset).
env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

# Checks environment $1 and takes its release lock, setting dir, project, repo and releases.
load_environment() {
  env=$1
  [[ $EUID -eq 0 ]] || fail "run as root (sudo)."
  [[ $READY_TIMEOUT =~ ^[1-9][0-9]{0,3}$ ]] || fail "RELEASE_READY_TIMEOUT must be a number of seconds."
  dir=$SRV_DIR/$env
  [[ -f $dir/.env && -f $dir/app.env && -f $dir/database.env && -d $dir/web ]] ||
    fail "$dir lacks .env, app.env, database.env or web/; run provision.sh."
  [[ -f $COMPOSE_FILE ]] || fail "$COMPOSE_FILE is missing; run provision.sh."
  project=$(env_value "$dir/.env" COMPOSE_PROJECT_NAME)
  [[ -n $project ]] || fail "$dir/.env has no COMPOSE_PROJECT_NAME; run provision.sh."
  repo=$(env_value "$CONF_DIR/deploy.conf" IMAGE_REPOSITORY)
  [[ -n $repo ]] || fail "$CONF_DIR/deploy.conf has no IMAGE_REPOSITORY; run provision.sh."
  releases=$dir/releases.log
  # A run goes on when whoever started it goes away (the release job's SSH session ends on a timeout or a cancel): a
  # deploy stopped between restarting the containers and recording the outcome would leave releases.log naming a
  # release that no longer runs. Its output also goes to release-output.log, which tee keeps writing once the session's
  # end of the pipe is gone.
  trap '' HUP PIPE
  exec > >(tee -p -a "$dir/release-output.log") 2>&1
  # One deploy or rollback of an environment at a time.
  exec 8>"$dir/.release.lock"
  flock -w 600 8 || fail "another deploy or rollback of $env is still running."
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) $SCRIPT.sh $env"
}

# Docker Compose for this environment, with image $1 as APP_IMAGE.
compose() {
  local image=$1
  shift
  APP_IMAGE=$image docker compose --project-directory "$dir" -f "$COMPOSE_FILE" "$@"
}

record() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 $2 $3" >>"$releases"; }

# Recorded releases that ran, oldest first, as "commit digest" lines.
ran_releases() {
  if [[ -f $releases ]]; then awk '$2 == "deploy" || $2 == "rollback" || $2 == "fallback" { print $3 " " $4 }' "$releases"; fi
}

# The release running now as "commit digest", empty before the first deploy.
current_release() { ran_releases | tail -n 1; }

# Pulls release $1's image by digest $2 when it is not here, and checks it is that commit's.
ensure_image() {
  local ref=$repo@$2 revision
  if ! docker image inspect "$ref" >/dev/null 2>&1; then
    timeout 900 docker pull -q "$ref" >/dev/null || fail "cannot pull $ref (network or registry trouble?)."
  fi
  revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref") ||
    fail "cannot inspect $ref."
  [[ $revision == "$1" ]] || fail "$ref is the image of commit ${revision:-(none)}, not of $1."
}

# The commits of the release in image $1 (its history), which the migration gate and the rollback check read.
release_commits() {
  docker run --rm --network none --entrypoint cat "$1" /app/release-commits.txt || fail "cannot read the commits of $1."
}

# Copies release $1's dashboard and counter builds out of image $2 into web/releases/$1, unless they are there.
extract_web() {
  local target=$dir/web/releases/$1 partial=$dir/web/releases/.$1.partial container
  [[ -d $target ]] && return 0
  install -d -m 0755 "$dir/web/releases"
  rm -rf "$partial"
  install -d -m 0755 "$partial"
  container=$(docker create "$2") || fail "cannot create a container of $2."
  if ! docker cp "$container:/app/web/." "$partial" >/dev/null; then
    docker rm "$container" >/dev/null
    fail "cannot copy the web builds out of $2."
  fi
  docker rm "$container" >/dev/null || fail "cannot remove container $container."
  mv "$partial" "$target" || fail "cannot move $partial into place."
}

# Points web/dashboard and web/counter at release $1's builds, each with one rename: Caddy serves the old or the new.
# Returns 1 on a failure, after the containers changed, so the caller records it and goes back.
switch_web() {
  local app
  for app in dashboard counter; do
    # Before the first deploy: the empty directory provision.sh made.
    if [[ -d $dir/web/$app && ! -L $dir/web/$app ]] && ! rmdir "$dir/web/$app"; then
      log "$dir/web/$app is not empty."
      return 1
    fi
    if ! ln -sfn "releases/$1/$app" "$dir/web/.$app.new" || ! mv -Tf "$dir/web/.$app.new" "$dir/web/$app"; then
      log "cannot point $dir/web/$app at release $1."
      return 1
    fi
  done
}

# Runs release $1 (commit) from image digest $2: its server and worker replace the running ones, then its web builds go
# live once the server is ready. Returns 1 (having changed only the containers) when the server is not ready within
# READY_TIMEOUT seconds or the worker stops.
start_release() {
  local image=$repo@$2 started server worker state previous_worker restarts=0
  extract_web "$1" "$image"
  previous_worker=$(compose "$image" ps -q worker 2>/dev/null) || true
  started=$SECONDS
  if ! compose "$image" up -d --no-deps server worker; then
    log "the $env server and worker of $1 did not start."
    return 1
  fi
  # Polled here: Compose's --wait succeeds when its timeout ends on a server still starting.
  server=$(compose "$image" ps -q server)
  until [[ $(docker inspect --format '{{.State.Health.Status}}' "$server" 2>/dev/null) == healthy ]]; do
    if ((SECONDS - started >= READY_TIMEOUT)); then
      log "the $env server of $1 was not ready within $READY_TIMEOUT s."
      return 1
    fi
    sleep 1
  done
  local downtime=$((SECONDS - started))
  # Compose counts a restarting container as up, so the worker must stay up on its own: running, and no restart since
  # now (a worker Compose kept, as on a redeploy of the running release, may have restarted before).
  worker=$(compose "$image" ps -q worker)
  [[ -n $worker && $worker == "$previous_worker" ]] && restarts=$(docker inspect --format '{{.RestartCount}}' "$worker")
  for _ in $(seq "$WORKER_SETTLE"); do
    sleep 1
    # Status, not Running: a container waiting to be restarted still counts as running.
    state=$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$worker" 2>/dev/null)
    if [[ $state != "running $restarts" ]]; then
      log "the $env worker of $1 stopped after it started."
      return 1
    fi
  done
  switch_web "$1" || return 1
  log "$env runs $1 (server restarted and ready in $downtime s)."
}

# The containers' states, for a failure report (their logs stay on the VPS: docker compose logs).
report_state() {
  compose "$1" ps -a --format '{{.Service}}: {{.Status}}' server worker >&2 || true
  echo "$SCRIPT: logs: sudo docker compose --project-directory $dir -f $COMPOSE_FILE logs server worker" >&2
}

# Removes the images and web builds of all but the last KEEP_RELEASES releases recorded in each environment (the
# environments share images).
prune_releases() {
  local keep path digest
  keep=$(for log in "$SRV_DIR"/*/releases.log; do
    [[ -f $log ]] && awk '$2 != "failed" { print $3 " " $4 }' "$log" | tac | awk '!seen[$0]++' | head -n "$KEEP_RELEASES"
  done)
  for path in "$dir"/web/releases/*; do
    [[ -d $path ]] || continue
    grep -q "^$(basename "$path") " <<<"$keep" || rm -rf "$path"
  done
  while read -r digest; do
    [[ -z $digest || $digest == '<none>' ]] && continue
    # An image a container still uses stays (docker refuses).
    grep -q " $digest\$" <<<"$keep" || docker image rm "$repo@$digest" >/dev/null 2>&1 || true
  done < <(docker image ls --digests --format '{{.Digest}}' "$repo" | sort -u)
}
