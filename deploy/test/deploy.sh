#!/usr/bin/env bash
# Runs deploy/deploy.sh and deploy/rollback.sh as on the VPS (`pnpm test:deploy`, part of `pnpm test`; needs Docker):
# as root in the Ubuntu 24.04 runner (deploy/test/runner.Dockerfile) with provision.sh's layout, the real Compose file
# and environment files, the deploy keys' authorized_keys and deploy.conf from provision.sh, and the release image
# built from this checkout, served by a local registry; deploy/ci/remote.sh reaches the scripts through a stand-in ssh
# (fake-ssh.sh) that applies the keys' forced commands. Images derived from it stand in for later releases: one adding
# an expand migration, one whose server never gets ready, one whose worker stops, and two adding a contract migration,
# one the running release is not yet at or after and one it is. Checks the pre-deploy backup, the migrations, readiness
# and downtime, the web switch after readiness, the fallbacks of deploy and rollback, a run outliving its session, the
# release records and pruning, rollbacks to any recorded release on the expanded schema (the previous image serving
# requests), the contract gates, the keys and argument checks. Fake data only.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_DIR=$(dirname "$DEPLOY_DIR")
readonly DEPLOY_DIR REPO_DIR
readonly NAME=cafe-loyalty-deploy-test-$$
readonly PROJECT=$NAME-staging
readonly REGISTRY_IMAGE=registry:3@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8
readonly ENV_DIR=/srv/cafe-loyalty/staging
WORK=$(mktemp -d)
readonly WORK

cleanup() {
  local kind
  docker rm -f -v "$NAME-runner" "$NAME-registry" >/dev/null 2>&1 || true
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | xargs docker rm -f -v >/dev/null 2>&1 || true
  for kind in volume network; do
    docker "$kind" ls -q --filter "label=com.docker.compose.project=$PROJECT" | xargs docker "$kind" rm >/dev/null 2>&1 || true
  done
  # The later releases' images and every name the registry's images got here (by tag, and by digest from the pulls).
  docker image ls --format '{{.Repository}}:{{.Tag}} {{.Repository}}@{{.Digest}}' | tr ' ' '\n' | grep -E "^${NAME}-|/${NAME}[:@]" |
    grep -v -e ':<none>$' -e '@<none>$' | xargs docker image rm >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

failures=0
check() {
  if [[ $2 == "$3" ]]; then
    echo "ok: $1"
  else
    echo "FAIL: $1: expected [$3], got [$2]" >&2
    failures=$((failures + 1))
  fi
}
said() { [[ $output == *"$1"* ]] && echo said; }
vps() { docker exec -i "$NAME-runner" bash -c "$1"; }
run() {
  status=0
  output=$(vps "$1" 2>&1) || status=$?
}
container_of() { docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1"; }
sql() { docker exec -i "$(container_of postgres)" psql -X -q -At -U postgres -d cafe_loyalty -c "$1"; }
running_image() { docker inspect --format '{{.Config.Image}}' "$(container_of server)"; }
web_release() { vps "readlink $ENV_DIR/web/dashboard $ENV_DIR/web/counter | tr '\n' ' '"; }
# The server as Caddy reaches it, on the loopback port the environment publishes.
http_status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }

# The release built from this checkout (A), as the release workflow builds it.
commit_a=$(git -C "$REPO_DIR" rev-parse HEAD)
git -C "$REPO_DIR" rev-list HEAD >"$REPO_DIR/release-commits.txt"
docker build -q -t cafe-loyalty-deploy-test-app --build-arg BUILD_ID="$commit_a" \
  --build-arg BUILT_AT="$(TZ=UTC git -C "$REPO_DIR" log -1 --format=%cd --date=format-local:%Y-%m-%dT%H:%M:%SZ)" "$REPO_DIR" >/dev/null
# shellcheck source=deploy/test/runner.sh
. "$DEPLOY_DIR/test/runner.sh"

# On both loopback addresses where the host has both: Docker Desktop's daemon (in its VM) reaches it only so. A loopback
# registry needs no TLS.
port=$((40000 + RANDOM % 20000))
if ! docker run -d --name "$NAME-registry" -p "127.0.0.1:$port:5000" -p "[::1]:$port:5000" "$REGISTRY_IMAGE" >/dev/null 2>&1; then
  docker rm -f "$NAME-registry" >/dev/null 2>&1 || true
  docker run -d --name "$NAME-registry" -p "127.0.0.1:$port:5000" "$REGISTRY_IMAGE" >/dev/null
fi
readonly REPO=127.0.0.1:$port/$NAME
for _ in $(seq 30); do
  curl -fs "http://127.0.0.1:$port/v2/" >/dev/null && break
  sleep 1
done

# Pushes image $1 as release $2 and prints its digest, as the registry has it.
push() {
  docker tag "$1" "$REPO:$2"
  docker push -q "$REPO:$2" >/dev/null
  curl -fsS -o /dev/null -D - -H 'Accept: application/vnd.oci.image.index.v1+json' -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' "http://127.0.0.1:$port/v2/$NAME/manifests/$2" |
    tr -d '\r' | sed -n 's/^docker-content-digest: //ip' | grep .
}
# Builds a later release on A: commit $1 (the history: $1, then $2's), the migrations in $WORK/$3, and a Dockerfile
# line $4 (or none).
derive() {
  local context=$WORK/$1
  mkdir -p "$context/migrations"
  cp "$WORK/$3"/*.sql "$context/migrations/" 2>/dev/null || true
  { echo "$1"; cat "$WORK/commits-$2"; } >"$context/release-commits.txt"
  cp "$context/release-commits.txt" "$WORK/commits-$1"
  printf '%s\n' "FROM cafe-loyalty-deploy-test-app" "USER root" "COPY release-commits.txt /app/release-commits.txt" \
    "COPY migrations/ /app/packages/db/migrations/" "${4:-}" "LABEL org.opencontainers.image.revision=$1" "USER node" >"$context/Dockerfile"
  docker build -q -t "$NAME-$1" "$context" >/dev/null
}
commit_b=$(printf 'b%.0s' {1..40}) commit_c=$(printf 'c%.0s' {1..40}) commit_d=$(printf 'd%.0s' {1..40})
commit_e=$(printf 'e%.0s' {1..40}) commit_w=$(printf '7%.0s' {1..40}) unknown=$(printf '9%.0s' {1..40})
cp "$REPO_DIR/release-commits.txt" "$WORK/commits-$commit_a"
count=$(find "$REPO_DIR/packages/db/migrations" -name '*.sql' | wc -l | tr -d ' ')
expand=$(printf '%04d_deploy_probe.sql' $((count + 1))) contract=$(printf '%04d_drop_probe_note.sql' $((count + 2)))
mkdir -p "$WORK/expand" "$WORK/gated" "$WORK/allowed"
printf '%s\n' "-- migration: expand" "CREATE TABLE deploy_probe (id int PRIMARY KEY, note text);" >"$WORK/expand/$expand"
cp "$WORK/expand/$expand" "$WORK/gated/" && cp "$WORK/expand/$expand" "$WORK/allowed/"
printf '%s\n' "-- migration: contract" "-- requires-deployed: $unknown" "ALTER TABLE deploy_probe DROP COLUMN note;" >"$WORK/gated/$contract"
printf '%s\n' "-- migration: contract" "-- requires-deployed: $commit_b" "ALTER TABLE deploy_probe DROP COLUMN note;" >"$WORK/allowed/$contract"
derive "$commit_b" "$commit_a" expand
derive "$commit_c" "$commit_b" expand "RUN echo 'setInterval(() => {}, 1000);' >apps/server/dist/main.js"
derive "$commit_d" "$commit_b" gated
derive "$commit_e" "$commit_b" allowed
derive "$commit_w" "$commit_b" expand "RUN echo 'setTimeout(() => process.exit(1), 2000);' >apps/worker/dist/main.js"
digest_a=$(push cafe-loyalty-deploy-test-app "$commit_a")
digest_b=$(push "$NAME-$commit_b" "$commit_b")
digest_c=$(push "$NAME-$commit_c" "$commit_c")
digest_d=$(push "$NAME-$commit_d" "$commit_d")
digest_e=$(push "$NAME-$commit_e" "$commit_e")
digest_w=$(push "$NAME-$commit_w" "$commit_w")
# As on the VPS, the daemon has the releases only by the digests it pulls.
for commit in "$commit_a" "$commit_b" "$commit_c" "$commit_d" "$commit_e" "$commit_w"; do docker image rm "$REPO:$commit" >/dev/null; done

proxy_port=$((20000 + RANDOM % 20000))
docker run -d --name "$NAME-runner" -v /var/run/docker.sock:/var/run/docker.sock -v "$DEPLOY_DIR:/deploy:ro" \
  "$RUNNER" sleep infinity >/dev/null
vps "set -e
  install -d -m 0755 /etc/cafe-loyalty /opt/cafe-loyalty/bin $ENV_DIR $ENV_DIR/web
  install -d -m 0700 $ENV_DIR/backups
  printf '%s\n' '#!/bin/sh' 'exec \"\$@\"' >/usr/local/bin/sudo && chmod 0755 /usr/local/bin/sudo
  install -m 0755 /deploy/test/fake-ssh.sh /usr/local/bin/ssh
  for key in production staging stranger; do ssh-keygen -q -t ed25519 -N '' -C deploy-\$key -f /root/\$key-key; done
  install -d -m 0755 /etc/ssh/authorized_keys
  PRODUCTION_DEPLOY_SSH_PUBLIC_KEY=\$(cat /root/production-key.pub) STAGING_DEPLOY_SSH_PUBLIC_KEY=\$(cat /root/staging-key.pub) \
    bash /deploy/provision.sh authorized-keys >/etc/ssh/authorized_keys/deploy
  for script in /deploy/*.sh; do [[ \$script == */provision.sh ]] || install -m 0755 \$script /opt/cafe-loyalty/bin/; done
  install -m 0644 /deploy/compose.yaml /opt/cafe-loyalty/compose.yaml
  IMAGE_REPOSITORY=$REPO bash /deploy/provision.sh deploy-conf /etc/cafe-loyalty >/dev/null
  printf '%s\n' COMPOSE_PROJECT_NAME=$PROJECT PROXY_PORT=$proxy_port >$ENV_DIR/.env
  PRODUCTION_DASHBOARD_DOMAIN=dashboard.example.test PRODUCTION_COUNTER_DOMAIN=counter.example.test \
    PRODUCTION_PUBLIC_DOMAIN=card.example.test STAGING_DASHBOARD_DOMAIN=dashboard.staging.example.test \
    STAGING_COUNTER_DOMAIN=counter.staging.example.test STAGING_PUBLIC_DOMAIN=card.staging.example.test \
    bash /deploy/provision.sh env-files $ENV_DIR >/dev/null
  sed -i -e 's/^SMTP_HOST=.*/SMTP_HOST=smtp.example.test/' -e 's/^SMTP_USER=.*/SMTP_USER=fake-user/' \
    -e 's/^SMTP_PASSWORD=.*/SMTP_PASSWORD=fake-smtp-password/' -e 's/^EMAIL_FROM=.*/EMAIL_FROM=test@example.test/' $ENV_DIR/app.env
  age-keygen -o /root/identity.txt 2>/dev/null
  printf '%s\n' BACKUP_AGE_RECIPIENT=\$(age-keygen -y /root/identity.txt) BACKUP_REMOTE=/offsite >/etc/cafe-loyalty/backup.conf"
# On a failure, its output and the server's last log lines (test data only).
show() {
  echo "$output" >&2
  docker logs --tail 20 "$(container_of server)" >&2 2>&1 || true
}
deploy() { run "RELEASE_READY_TIMEOUT=20 /opt/cafe-loyalty/bin/deploy.sh staging $1 $2"; }
# deploy/ci/remote.sh as the release workflow runs it, with environment $1's key: remote <environment> <script> <args>.
remote() {
  run "DEPLOY_HOST=vps.example.test DEPLOY_USER=deploy DEPLOY_SSH_KEY=\"\$(cat /root/$1-key)\" \
    DEPLOY_KNOWN_HOSTS='vps.example.test ssh-ed25519 AAAA' RELEASE_READY_TIMEOUT=20 bash /deploy/ci/remote.sh ${*:2}"
}
records() { vps "tail -n $1 $ENV_DIR/releases.log | awk '{ print \$2, \$3 }' | tr '\n' ' '"; }
rollback() { run "/opt/cafe-loyalty/bin/rollback.sh staging $*"; }
migrations() { sql "SELECT count(*) FROM meta.schema_migrations"; }

run "/opt/cafe-loyalty/bin/deploy.sh prod $commit_a $digest_a"
check "a usage error for an unknown environment" "$status" 1
run "/opt/cafe-loyalty/bin/deploy.sh staging main $digest_a"
check "a usage error for a commit that is not 40 hex characters" "$status" 1
run "/opt/cafe-loyalty/bin/deploy.sh staging $commit_a latest"
check "a usage error for a digest that is not sha256" "$status" 1
run "/opt/cafe-loyalty/bin/deploy.sh staging $commit_a '$digest_a;id'"
check "a usage error for an argument with more after it" "$status" 1
run "/opt/cafe-loyalty/bin/release-common.sh"
check "the shared file refuses to run on its own" "$status" 1
run "/opt/cafe-loyalty/bin/rollback.sh staging"
check "nothing to roll back before the first deploy" "$status" 1
run "/opt/cafe-loyalty/bin/deploy.sh staging $commit_a $digest_b"
check "an image of another commit is refused" "$status" 1
check "that refusal says why" "$(said "is the image of commit $commit_b, not of $commit_a")" said

# The deploy keys' forced command (no real sudo in the stand-in: it runs the command as root already).
gate() { run "SSH_ORIGINAL_COMMAND='$2' /opt/cafe-loyalty/bin/ssh-command.sh $1"; }
gate staging "sudo /opt/cafe-loyalty/bin/deploy.sh production $commit_a $digest_a"
check "the staging key cannot deploy to production" "$status" 2
gate staging "sudo /opt/cafe-loyalty/bin/backup.sh staging"
check "nor run another script" "$status" 2
gate staging "bash -c id"
check "nor any other command" "$status" 2
gate staging "sudo /opt/cafe-loyalty/bin/deploy.sh staging $commit_a \$(id)"
check "nor pass an argument the remote shell would expand" "$status" 2

# The keys provision.sh writes, used through remote.sh as the release workflow does.
check "each key's line forces its own environment's command" \
  "$(vps "for env in production staging; do grep -cx \"restrict,command=\\\"/opt/cafe-loyalty/bin/ssh-command.sh \$env\\\" \$(cat /root/\$env-key.pub)\" /etc/ssh/authorized_keys/deploy; done | tr '\n' ' '")" "1 1 "
check "and nothing else is in the file" "$(vps 'wc -l </etc/ssh/authorized_keys/deploy')" 2
run "PRODUCTION_DEPLOY_SSH_PUBLIC_KEY=\"\$(cat /root/staging-key.pub)\" STAGING_DEPLOY_SSH_PUBLIC_KEY=\"\$(cat /root/staging-key.pub)\" \
  bash /deploy/provision.sh authorized-keys"
check "provision.sh refuses one key for both environments" "$status" 1
run "PRODUCTION_DEPLOY_SSH_PUBLIC_KEY='ssh-ed25519 not-a-key' STAGING_DEPLOY_SSH_PUBLIC_KEY=\"\$(cat /root/staging-key.pub)\" \
  bash /deploy/provision.sh authorized-keys"
check "and a line that is not a key" "$status" 1
run "IMAGE_REPOSITORY=ghcr.io/owner/cafe-loyalty:latest bash /deploy/provision.sh deploy-conf /tmp"
check "and an image repository with a tag" "$status" 1
check "deploy.conf names the repository" "$(vps 'cat /etc/cafe-loyalty/deploy.conf | grep -v "^#"')" "IMAGE_REPOSITORY=$REPO"
remote staging deploy.sh production "$commit_a" "$digest_a"
check "the staging key cannot deploy to production" "$status" 2
remote staging rollback.sh staging
check "the staging key runs staging's scripts" "$(said "staging has no release yet")" said
remote production rollback.sh production
check "the production key runs production's" "$(said "/srv/cafe-loyalty/production lacks")" said
remote stranger rollback.sh staging
check "another key is refused" "$status" 255
remote staging rollback.sh "'staging;id'"
check "remote.sh refuses an argument the remote shell would read" "$status" 2

remote staging deploy.sh staging "$commit_a" "$digest_a"
check "the first deploy succeeds" "$status" 0
[[ $status -eq 0 ]] || show
check "it migrates a new database fully" "$(migrations)" "$count"
check "the server runs the release image by digest" "$(running_image)" "$REPO@$digest_a"
check "the web builds are the release's" "$(web_release)" "releases/$commit_a/dashboard releases/$commit_a/counter "
check "Caddy finds the dashboard and counter builds" "$(vps "ls $ENV_DIR/web/dashboard/index.html $ENV_DIR/web/counter/sw.js | wc -l")" 2
check "the server is ready on its loopback port" "$(http_status "http://127.0.0.1:$proxy_port/health/ready")" 200
check "PostgreSQL publishes no port" "$(docker port "$(container_of postgres)")" ""
check "the release is recorded" "$(vps "awk '{ print \$2, \$3, \$4 }' $ENV_DIR/releases.log")" "deploy $commit_a $digest_a"
check "no backup is made before the first deploy" "$(vps "ls $ENV_DIR/backups | wc -l")" 0
# provision.sh on an environment whose settings files are lost but whose database volume is there.
run "mkdir -p /root/lost && cp $ENV_DIR/.env /root/lost/ && PRODUCTION_DASHBOARD_DOMAIN=dashboard.example.test \
  PRODUCTION_COUNTER_DOMAIN=counter.example.test PRODUCTION_PUBLIC_DOMAIN=card.example.test \
  STAGING_DASHBOARD_DOMAIN=dashboard.staging.example.test STAGING_COUNTER_DOMAIN=counter.staging.example.test \
  STAGING_PUBLIC_DOMAIN=card.staging.example.test bash /deploy/provision.sh env-files /root/lost"
check "provision.sh makes no new passwords over a database volume" "$status" 1
check "it says to restore them" "$(said "the production database volume is there; restore both from a backup")" said
check "and writes nothing" "$(vps 'ls /root/lost')" ""
check "the run's output is kept on the VPS" "$(vps "grep -c 'staging runs $commit_a' $ENV_DIR/release-output.log")" 1
sql "INSERT INTO app.cafes (name) VALUES ('Deploy Test Cafe')"

deploy "$commit_b" "$digest_b"
check "a deploy with an expand migration succeeds" "$status" 0
[[ $status -eq 0 ]] || show
check "it takes an encrypted pre-deploy backup first" "$(vps 'ls /offsite/staging/predeploy | grep -c "predeploy.tar.age$"')" 1
check "it applies the expand migration" "$(migrations)" $((count + 1))
check "the server runs the new release" "$(running_image)" "$REPO@$digest_b"
check "the web builds switch to the new release" "$(web_release)" "releases/$commit_b/dashboard releases/$commit_b/counter "
downtime=$(sed -n 's/.*restarted and ready in \([0-9]*\) s.*/\1/p' <<<"$output")
check "the server is back within 30 seconds" "$([[ -n $downtime && $downtime -lt 30 ]] && echo fast || echo "$downtime")" fast
check "the data is kept" "$(sql 'SELECT count(*) FROM app.cafes')" 1

# In the background, to look at the web builds while the deploy waits for the new server.
vps "RELEASE_READY_TIMEOUT=20 /opt/cafe-loyalty/bin/deploy.sh staging $commit_c $digest_c >/root/c.out 2>&1; echo \$? >/root/c.status" &
for _ in $(seq 120); do
  [[ $(running_image 2>/dev/null) == "$REPO@$digest_c" ]] && break
  sleep 0.5
done
check "the server is replaced first" "$(running_image)" "$REPO@$digest_c"
check "while the server is not ready, the web builds stay the running release's" "$(web_release)" \
  "releases/$commit_b/dashboard releases/$commit_b/counter "
wait
output=$(vps 'cat /root/c.out') status=$(vps 'cat /root/c.status')
check "a release that never gets ready fails the deploy" "$status" 1
[[ $status -ne 0 ]] || show
check "the failure says what happened" "$(said "$commit_c did not get ready, so staging is back on $commit_b")" said
check "the previous release runs again" "$(running_image)" "$REPO@$digest_b"
check "and is ready" "$(http_status "http://127.0.0.1:$proxy_port/health/ready")" 200
check "its web builds stay" "$(web_release)" "releases/$commit_b/dashboard releases/$commit_b/counter "
check "no migration is undone" "$(migrations)" $((count + 1))
check "the failure and the fallback are recorded" "$(records 2)" "failed $commit_c fallback $commit_b "
check "the web links are symbolic links, with nothing left half done" \
  "$(vps "find $ENV_DIR/web -maxdepth 1 -type l | wc -l; ls -A $ENV_DIR/web | grep -c '^\\.' || true" | tr '\n' ' ')" "2 0 "

deploy "$commit_w" "$digest_w"
check "a release whose worker stops fails the deploy" "$status" 1
check "that failure says so" "$(said "the staging worker of $commit_w stopped after it started")" said
check "the previous release runs again" "$(running_image)" "$REPO@$digest_b"
check "with its web builds" "$(web_release)" "releases/$commit_b/dashboard releases/$commit_b/counter "
check "both are recorded" "$(records 2)" "failed $commit_w fallback $commit_b "

# A worker that restarted once since its deploy, then a redeploy of the running release (a re-run release job) whose
# SSH session ends after the first byte of output: the run goes on and records its outcome.
worker=$(container_of worker)
docker exec "$worker" sh -c 'kill 1'
for _ in $(seq 60); do
  [[ $(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$worker") == "true 1" ]] && break
  sleep 0.5
done
check "the worker restarted once" "$(docker inspect --format '{{.RestartCount}}' "$worker")" 1
run "RELEASE_READY_TIMEOUT=20 /opt/cafe-loyalty/bin/deploy.sh staging $commit_b $digest_b | head -c 1 >/dev/null"
check "a redeploy of the running release succeeds, its session gone" "$(records 1)" "deploy $commit_b "
check "the run's output is still kept" "$(vps "tail -n 1 $ENV_DIR/release-output.log")" \
  "$(vps "grep 'staging runs $commit_b' $ENV_DIR/release-output.log | tail -n 1")"
check "the worker Compose kept still runs" "$(container_of worker)" "$worker"

# A web switch that fails after the containers changed (a directory where the new link goes): recorded, and the
# fallback, failing the same way, says the environment is down; the links never moved.
vps "mkdir -p $ENV_DIR/web/.dashboard.new/blocked"
deploy "$commit_b" "$digest_b"
check "a failed web switch fails the deploy" "$status" 1
check "and says what failed" "$(said "cannot point $ENV_DIR/web/dashboard at release $commit_b")" said
check "a fallback failing too says the environment is down" "$(said "neither did $commit_b after it: staging is down")" said
check "the failure is recorded" "$(records 1)" "failed $commit_b "
check "the web links stay where they were" "$(web_release)" "releases/$commit_b/dashboard releases/$commit_b/counter "
vps "rm -r $ENV_DIR/web/.dashboard.new"

rollback
check "a rollback to the previous release succeeds" "$status" 0
[[ $status -eq 0 ]] || show
check "the previous release runs" "$(running_image)" "$REPO@$digest_a"
check "on the expanded schema" "$(migrations)" $((count + 1))
check "and serves requests" "$(http_status "http://127.0.0.1:$proxy_port/health/ready")" 200
check "its API answers from the database" "$(http_status -X POST -H 'content-type: application/json' \
  -d '{"email":"nobody@example.test","password":"not-the-password"}' "http://127.0.0.1:$proxy_port/api/auth/login")" 401
check "with its own web builds" "$(web_release)" "releases/$commit_a/dashboard releases/$commit_a/counter "
check "the rollback is recorded" "$(vps "tail -n 1 $ENV_DIR/releases.log | awk '{ print \$2, \$3 }'")" "rollback $commit_a"
rollback "$commit_c"
check "a release that never ran is refused" "$status" 1
rollback "$commit_b"
check "a rollback to a chosen recorded release succeeds" "$status" 0
check "it runs" "$(running_image)" "$REPO@$digest_b"
# As if the never-ready release had once run: a rollback to it goes back to the current release.
vps "sed -i '1i 2026-01-01T00:00:00Z deploy $commit_c $digest_c' $ENV_DIR/releases.log"
rollback "$commit_c"
check "a rollback to a release that does not get ready fails" "$status" 1
check "that failure says so" "$(said "$commit_c did not get ready, so staging is back on $commit_b")" said
check "the current release runs again" "$(running_image)" "$REPO@$digest_b"
check "with its web builds" "$(web_release)" "releases/$commit_b/dashboard releases/$commit_b/counter "
check "both are recorded" "$(records 2)" "failed $commit_c fallback $commit_b "
vps "sed -i 1d $ENV_DIR/releases.log"

deploy "$commit_d" "$digest_d"
check "a contract migration the running release is not at or after is refused" "$status" 1
check "the refusal names it" "$(said "$contract (requires-deployed $unknown)")" said
check "nothing is migrated" "$(migrations)" $((count + 1))
check "nothing is restarted" "$(running_image)" "$REPO@$digest_b"

# Four older releases before the first, so the next deploy keeps the newest five of the six that ran.
old=()
for i in 1 2 3 4; do
  old+=("$(printf "f$i%.0s" {1..20})")
  vps "sed -i '$i i 2025-01-0${i}T00:00:00Z deploy ${old[i - 1]} sha256:$(printf "$i%.0s" {1..64})' $ENV_DIR/releases.log
    mkdir -p $ENV_DIR/web/releases/${old[i - 1]}/dashboard $ENV_DIR/web/releases/${old[i - 1]}/counter"
done
deploy "$commit_e" "$digest_e"
check "a contract migration the running release is at or after is applied" "$status" 0
[[ $status -eq 0 ]] || show
check "both migrations are in" "$(migrations)" $((count + 2))
check "the contract migration's release is recorded in the database" \
  "$(sql "SELECT requires_deployed FROM meta.schema_migrations WHERE requires_deployed IS NOT NULL")" "$commit_b"
check "the web builds of the five newest releases that ran are kept, and no others" "$(vps "ls $ENV_DIR/web/releases | tr '\n' ' '")" \
  "$(printf '%s\n' "$commit_b" "$commit_e" "$commit_a" "${old[2]}" "${old[3]}" | sort | tr '\n' ' ')"
for kept in a b e; do
  digest=digest_$kept
  check "the image of a kept release stays ($kept)" "$(docker image inspect -f ok "$REPO@${!digest}" 2>/dev/null)" ok
done
for gone in c d w; do
  digest=digest_$gone
  check "the image of a release that never ran is removed ($gone)" "$(docker image inspect -f ok "$REPO@${!digest}" 2>/dev/null || true)" ""
done
deploy "$commit_b" "$digest_b"
check "a release older than the running one is not deployed" "$status" 1
check "that refusal points to rollback.sh" "$(said "is not at or after the running $commit_e")" said
check "nothing changes" "$(running_image)" "$REPO@$digest_e"
rollback "$commit_a"
check "a release from before an applied contract migration is refused" "$status" 1
check "that refusal says why" "$(said "is from before $commit_b")" said
check "and changes nothing" "$(running_image)" "$REPO@$digest_e"
rollback
check "a release at or after it may run" "$status" 0
check "it runs" "$(running_image)" "$REPO@$digest_b"

if ((failures > 0)); then
  echo "$failures deploy check(s) failed." >&2
  exit 1
fi
echo "All deploy checks passed."
