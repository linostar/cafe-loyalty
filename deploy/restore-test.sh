#!/usr/bin/env bash
# Restores one environment's backup into a throwaway database and checks it (AC 56): `restore-test.sh
# <production|staging> [<backup name>]`, as root (the monthly timer, or by hand). Without a name it takes the newest
# nightly backup, which must be under two days old, and whose encrypted copy must be off-site. The throwaway database
# runs in a container of the environment's own PostgreSQL image, without a network, removed afterwards; the checks
# print counts only, never data.
set -euo pipefail

readonly APP=cafe-loyalty
readonly SRV_DIR=/srv/$APP
readonly CONF_DIR=/etc/$APP
readonly MAX_AGE_HOURS=48

fail() {
  echo "restore-test: $*" >&2
  exit 1
}
log() { echo "restore-test: $*"; }

# The value of setting $2 in env file $1 (empty when unset).
env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

env=${1:-}
name=${2:-}
if ! [[ $# -le 2 && ($env == production || $env == staging) && (-z $name || $name =~ ^[0-9]{8}T[0-9]{6}Z-(nightly|predeploy)$) ]]; then
  fail "usage: restore-test.sh <production|staging> [<backup name, such as 20261011T013000Z-nightly>]"
fi
[[ $EUID -eq 0 ]] || fail "run as root."

dir=$SRV_DIR/$env
backups=$dir/backups
[[ -d $backups ]] || fail "$backups does not exist; run provision.sh."
project=$(env_value "$dir/.env" COMPOSE_PROJECT_NAME)
database=$(env_value "$dir/database.env" DATABASE_NAME)
[[ -n $project && -n $database ]] || fail "$dir/.env or database.env lacks COMPOSE_PROJECT_NAME or DATABASE_NAME; run provision.sh."
remote=$(env_value "$CONF_DIR/backup.conf" BACKUP_REMOTE)
[[ -n $remote ]] || fail "$CONF_DIR/backup.conf lacks BACKUP_REMOTE; run provision.sh."

exec 9>"$backups/.lock"
flock -w 900 9 || fail "another backup or restore test of $env is still running."

container=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=postgres | head -n 1)
if [[ -z $container ]]; then
  if [[ -z $name && -z $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]]; then
    log "$env has no database yet (never deployed); nothing to test."
    exit 0
  fi
  fail "$env has no PostgreSQL container, whose image the test uses."
fi
image=$(docker inspect -f '{{.Image}}' "$container")

if [[ -z $name ]]; then
  newest=
  for path in "$backups"/*-nightly; do
    [[ -d $path ]] && newest=$(basename "$path")
  done
  [[ -n $newest ]] || fail "$env has no nightly backup in $backups."
  name=$newest
  taken=$(date -u -d "${name:0:8} ${name:9:2}:${name:11:2}:${name:13:2}" +%s)
  (($(date -u +%s) - taken <= MAX_AGE_HOURS * 3600)) ||
    fail "the newest nightly backup of $env, $name, is over $MAX_AGE_HOURS hours old (systemctl status $APP-backup@$env)."
  [[ $(rclone --config "$CONF_DIR/rclone.conf" lsf "$remote/$env/nightly/$name.tar.age") == "$name.tar.age" ]] ||
    fail "$name.tar.age is not in $remote/$env/nightly."
fi
backup=$backups/$name
[[ -f $backup/roles.sql && -f $backup/database.dump ]] || fail "$backup is not a complete backup."

throwaway=$APP-restore-test-$env
remove_throwaway() { docker rm -f -v "$throwaway" >/dev/null 2>&1 || true; }
remove_throwaway
trap remove_throwaway EXIT
# No network, so trust authentication reaches only `docker exec` from this host's root.
docker run -d --name "$throwaway" --network none -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null ||
  fail "cannot start a throwaway PostgreSQL container."
# Over TCP, which only the final server listens on (the image's initialisation server takes the socket alone).
for _ in $(seq 60); do
  docker exec "$throwaway" pg_isready -q -h 127.0.0.1 -U postgres && break
  sleep 1
done
docker exec "$throwaway" pg_isready -q -h 127.0.0.1 -U postgres || fail "the throwaway PostgreSQL did not start (docker logs $throwaway)."

psql() { docker exec -i "$throwaway" psql -X -q -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres "$@"; }
# The throwaway server's own superuser is postgres already.
# Their errors can quote a row's data, so they never reach the journal: rerun by hand to see them.
grep -vx 'CREATE ROLE postgres;' "$backup/roles.sql" | psql -d postgres >/dev/null 2>&1 ||
  fail "cannot restore the roles of $name (rerun by hand to see why)."
docker exec -i "$throwaway" pg_restore -h 127.0.0.1 -U postgres --create --exit-on-error -d postgres <"$backup/database.dump" 2>/dev/null ||
  fail "cannot restore the database of $name (pg_restore's errors can quote data, so they are not logged: rerun pg_restore by hand to see them)."

check() { [[ $2 == "$3" ]] || fail "$name: $1 (expected $3, got $2)."; }
query() { psql -d "$database" -c "$1"; }
migrations=$(query "SELECT count(*) FROM meta.schema_migrations")
((migrations > 0)) || fail "$name: no migrations recorded."
check "tables in schema app without forced row-level security" \
  "$(query "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")" 0
check "cl_app without superuser or BYPASSRLS" "$(query "SELECT count(*) FROM pg_roles WHERE rolname = 'cl_app' AND NOT rolsuper AND NOT rolbypassrls")" 1
check "rows cl_app sees in app.cafes without a café" "$(query "SET ROLE cl_app; SELECT count(*) FROM app.cafes")" 0
counts=$(query "SELECT string_agg(format('%s %s', table_name, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM app.%I', table_name), false, true, '')))[1]::text), ', ' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'app' AND table_type = 'BASE TABLE'")
log "restored $name: $migrations migrations, rows: $counts."
