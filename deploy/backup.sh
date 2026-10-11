#!/usr/bin/env bash
# Backs up one environment's database (AC 55): `backup.sh <production|staging> [nightly|predeploy]`, as root (the
# nightly timer, the deploy script, or the deploy user through sudo). Writes /srv/cafe-loyalty/<environment>/backups/
# <name>/ with roles.sql (roles and memberships, no passwords) and database.dump (pg_dump's custom format), then copies
# it off-site, together with the environment's app.env and database.env (without which the data is unusable), encrypted
# with age to the recipient in /etc/cafe-loyalty/backup.conf, whose private key never comes to the VPS. Plaintext never
# leaves the VPS. Then prunes both places by the retention policy below.
set -euo pipefail

readonly APP=cafe-loyalty
readonly SRV_DIR=/srv/$APP
readonly CONF_DIR=/etc/$APP
# Retention: backups of each kind kept on the VPS (the newest), and days a copy is kept off-site. The nightly backup of
# the 1st of each month is also kept off-site as a monthly one.
readonly KEEP_NIGHTLY=7 KEEP_PREDEPLOY=3
readonly OFFSITE_DAYS_NIGHTLY=35 OFFSITE_DAYS_PREDEPLOY=14 OFFSITE_DAYS_MONTHLY=400

fail() {
  echo "backup: $*" >&2
  exit 1
}
log() { echo "backup: $*"; }

# The value of setting $2 in env file $1 (empty when unset).
env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

env=${1:-}
kind=${2:-nightly}
[[ $# -le 2 && ($env == production || $env == staging) && ($kind == nightly || $kind == predeploy) ]] ||
  fail "usage: backup.sh <production|staging> [nightly|predeploy]"
[[ $EUID -eq 0 ]] || fail "run as root."

dir=$SRV_DIR/$env
backups=$dir/backups
[[ -d $backups ]] || fail "$backups does not exist; run provision.sh."
project=$(env_value "$dir/.env" COMPOSE_PROJECT_NAME)
user=$(env_value "$dir/database.env" POSTGRES_USER)
database=$(env_value "$dir/database.env" DATABASE_NAME)
PGPASSWORD=$(env_value "$dir/database.env" POSTGRES_PASSWORD)
export PGPASSWORD
[[ -n $project ]] || fail "$dir/.env has no COMPOSE_PROJECT_NAME; run provision.sh."
[[ -n $user && -n $database && -n $PGPASSWORD ]] || fail "$dir/database.env lacks POSTGRES_USER, POSTGRES_PASSWORD or DATABASE_NAME."
recipient=$(env_value "$CONF_DIR/backup.conf" BACKUP_AGE_RECIPIENT)
remote=$(env_value "$CONF_DIR/backup.conf" BACKUP_REMOTE)
[[ -n $recipient && -n $remote ]] || fail "$CONF_DIR/backup.conf lacks BACKUP_AGE_RECIPIENT or BACKUP_REMOTE; run provision.sh."
offsite() { rclone --config "$CONF_DIR/rclone.conf" "$@"; }

# One backup or restore test of an environment at a time.
exec 9>"$backups/.lock"
flock -w 900 9 || fail "another backup or restore test of $env is still running."

container=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=postgres)
if [[ -z $container ]]; then
  if [[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]]; then
    log "$env has no database yet (never deployed); nothing to back up."
    exit 0
  fi
  fail "the $env PostgreSQL container is not running (docker ps -a --filter label=com.docker.compose.project=$project)."
fi
[[ $container != *$'\n'* ]] || fail "more than one $env PostgreSQL container is running."

name=$(date -u +%Y%m%dT%H%M%SZ)-$kind
partial=$backups/.$name.partial
encrypted=$backups/.$name.tar.age
[[ ! -e $backups/$name ]] || fail "$backups/$name exists already; try again in a second."
trap 'rm -rf "$partial" "$encrypted"' EXIT
install -d -m 0700 "$partial"
# The container's own client tools, so they always match its server; over TCP with the superuser's password, because
# only a superuser reads past row-level security.
docker exec -e PGPASSWORD "$container" pg_dumpall -h localhost -U "$user" --roles-only --no-role-passwords >"$partial/roles.sql" ||
  fail "cannot dump the $env roles."
docker exec -e PGPASSWORD "$container" pg_dump -h localhost -U "$user" -d "$database" --format custom >"$partial/database.dump" ||
  fail "cannot dump the $env database."
mv "$partial" "$backups/$name"
log "wrote $backups/$name ($(du -sh "$backups/$name" | cut -f1))."

tar -cf - -C "$backups" "$name" -C "$dir" --transform "s|^app\.env\$|$name/app.env|" \
  --transform "s|^database\.env\$|$name/database.env|" app.env database.env | age -r "$recipient" -o "$encrypted" ||
  fail "cannot encrypt $name."
targets=("$kind")
[[ $kind == nightly && ${name:6:2} == 01 ]] && targets+=(monthly)
for target in "${targets[@]}"; do
  offsite copyto "$encrypted" "$remote/$env/$target/$name.tar.age" || fail "cannot copy $name to $remote/$env/$target."
  log "copied $name.tar.age to $remote/$env/$target."
done

for entry in nightly:$KEEP_NIGHTLY predeploy:$KEEP_PREDEPLOY; do
  found=()
  # The glob sorts by name, so oldest first.
  for path in "$backups"/*-"${entry%%:*}"; do
    [[ -d $path ]] && found+=("$path")
  done
  for ((i = 0; i < ${#found[@]} - ${entry#*:}; i++)); do
    rm -rf "${found[i]}"
    log "removed $(basename "${found[i]}") from the VPS."
  done
done
# Only kinds already copied: rclone fails on a folder that does not exist.
folders=$(offsite lsf --dirs-only "$remote/$env") || fail "cannot list $remote/$env."
for entry in nightly:$OFFSITE_DAYS_NIGHTLY predeploy:$OFFSITE_DAYS_PREDEPLOY monthly:$OFFSITE_DAYS_MONTHLY; do
  grep -Fx "${entry%%:*}/" <<<"$folders" >/dev/null || continue
  offsite delete --min-age "${entry#*:}d" "$remote/$env/${entry%%:*}" || fail "cannot prune $remote/$env/${entry%%:*}."
done
