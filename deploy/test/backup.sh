#!/usr/bin/env bash
# Runs deploy/backup.sh and deploy/restore-test.sh as on the VPS (`pnpm test:deploy`, part of `pnpm test`; needs Docker
# and the built db package): as root in an Ubuntu 24.04 container with the VPS's age and rclone, against a PostgreSQL
# container labelled as a Compose project's `postgres` service and bootstrapped and migrated by the real CLIs. A local
# directory stands in for the off-site remote, and the test holds the age identity the VPS never has, to check the
# encrypted copy, and a `date` shim sets the clock of a run (FAKE_NOW) so the monthly copy is made on purpose. Also walks
# the README's recovery (decrypt, extract, restore over a lost database), and sends the failure alert provision.sh
# generates to a local HTTPS listener. Fake data only.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
REPO_DIR=$(dirname "$DEPLOY_DIR")
readonly DEPLOY_DIR REPO_DIR
readonly NAME=cafe-loyalty-backup-test-$$
readonly POSTGRES_PASSWORD=fake-superuser-password-for-tests
# Stands in for app.env's secrets: must never appear unencrypted off-site.
readonly APP_SECRET=FakePepperForTheBackupTestOnly0123456789
POSTGRES_IMAGE=$(sed -n 's/^ *image: \(postgres:[^ ]*\).*/\1/p' "$REPO_DIR/compose.dev.yaml")
readonly POSTGRES_IMAGE
readonly PYTHON_IMAGE=python:3.13-alpine@sha256:2d9aefe2fef018a7eb2c13064c89c71929800fd2e5dccdbf52ea5da5bb8d929a

cleanup() {
  docker rm -f -v "$NAME-postgres" "$NAME-runner" "$NAME-alert" cafe-loyalty-restore-test-production >/dev/null 2>&1 || true
  docker volume rm "$NAME-data" "$NAME-certs" >/dev/null 2>&1 || true
  docker network rm "$NAME-net" >/dev/null 2>&1 || true
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
# Runs a shell command in the VPS stand-in, as root.
vps() { docker exec -i "$NAME-runner" bash -c "$1"; }
# Runs a VPS command, keeping its exit status in $status and its output in $output.
run() {
  status=0
  output=$(vps "$1" 2>&1) || status=$?
}
sql() { docker exec -i "$NAME-postgres" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d cafe_loyalty -c "$1"; }

# shellcheck source=deploy/test/runner.sh
. "$DEPLOY_DIR/test/runner.sh"

docker volume create --label "com.docker.compose.project=$NAME-production" "$NAME-data" >/dev/null
docker run -d --name "$NAME-postgres" --label "com.docker.compose.project=$NAME-production" \
  --label com.docker.compose.service=postgres -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -v "$NAME-data:/var/lib/postgresql" -p 127.0.0.1::5432 "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 60); do
  docker exec "$NAME-postgres" pg_isready -q -h 127.0.0.1 -U postgres && break
  sleep 1
done
port=$(docker port "$NAME-postgres" 5432/tcp | head -n 1 | sed 's/.*://')
export LOG_LEVEL=warn DATABASE_NAME=cafe_loyalty MIGRATOR_ROLE=cafe_loyalty_migrator APP_ROLE=cafe_loyalty_app
export DATABASE_ADMIN_URL=postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:$port/postgres
export MIGRATOR_PASSWORD=fake-migrator-password-for-tests APP_PASSWORD=fake-app-password-for-tests
export MIGRATOR_DATABASE_URL=postgres://cafe_loyalty_migrator:$MIGRATOR_PASSWORD@127.0.0.1:$port/cafe_loyalty
node "$REPO_DIR/packages/db/dist/bootstrap-cli.js"
node "$REPO_DIR/packages/db/dist/migrate-cli.js"
sql "INSERT INTO app.cafes (name) VALUES ('Backup Test Cafe'), ('Second Test Cafe')"

docker network create "$NAME-net" >/dev/null
docker run -d --name "$NAME-runner" --network "$NAME-net" -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$DEPLOY_DIR:/deploy:ro" -v "$NAME-certs:/certs" "$RUNNER" sleep infinity >/dev/null
vps "set -e
  install -d -m 0755 /srv/cafe-loyalty /etc/cafe-loyalty /opt/cafe-loyalty/bin
  install -m 0755 /deploy/backup.sh /deploy/restore-test.sh /opt/cafe-loyalty/bin/
  printf '%s\n' '#!/bin/sh' 'if [ -n \"\${FAKE_NOW:-}\" ]; then exec /usr/bin/date -d \"\$FAKE_NOW\" \"\$@\"; fi' \
    'exec /usr/bin/date \"\$@\"' >/usr/local/bin/date
  chmod 0755 /usr/local/bin/date
  for env in production staging; do
    install -d -m 0700 /srv/cafe-loyalty/\$env/backups
    echo COMPOSE_PROJECT_NAME=$NAME-\$env >/srv/cafe-loyalty/\$env/.env
    printf '%s\n' POSTGRES_USER=postgres POSTGRES_PASSWORD=$POSTGRES_PASSWORD DATABASE_NAME=cafe_loyalty >/srv/cafe-loyalty/\$env/database.env
    echo PHONE_LOOKUP_PEPPER=$APP_SECRET >/srv/cafe-loyalty/\$env/app.env
  done
  age-keygen -o /root/identity.txt 2>/dev/null
  printf '%s\n' BACKUP_AGE_RECIPIENT=\$(age-keygen -y /root/identity.txt) BACKUP_REMOTE=/offsite >/etc/cafe-loyalty/backup.conf
  # Older backups for the retention policy: 8 nightly and 4 pre-deploy on the VPS, and off-site copies of several ages.
  for day in 1 2 3 4 5 6 7 8; do mkdir -m 0700 /srv/cafe-loyalty/production/backups/2020010\${day}T013000Z-nightly; done
  for day in 1 2 3 4; do mkdir -m 0700 /srv/cafe-loyalty/production/backups/2020010\${day}T020000Z-predeploy; done
  mkdir -p /offsite/production/nightly /offsite/production/monthly /offsite/production/predeploy
  touch -d '40 days ago' /offsite/production/nightly/old.tar.age
  touch -d '20 days ago' /offsite/production/nightly/recent.tar.age /offsite/production/predeploy/old.tar.age
  touch -d '10 days ago' /offsite/production/predeploy/recent.tar.age
  touch -d '100 days ago' /offsite/production/monthly/old.tar.age"
# The clock of the main run: now, but never the 1st of a month (UTC), whose nightly backup is also a monthly one.
now=$(date -u +%s)
[[ $(date -u +%d) != 01 ]] || now=$((now - 86400))

run '/opt/cafe-loyalty/bin/backup.sh prod'
check "a usage error for an unknown environment" "$status" 1
run '/opt/cafe-loyalty/bin/backup.sh production nightly x'
check "a usage error for an extra argument" "$status" 1
run '/opt/cafe-loyalty/bin/restore-test.sh production ../../etc'
check "a usage error for a backup name that is a path" "$status" 1
run '/opt/cafe-loyalty/bin/backup.sh staging'
check "an environment never deployed is skipped" "$status" 0
check "the skip says why" "$([[ $output == *'nothing to back up'* ]] && echo said)" said

run "FAKE_NOW='2020-02-01 01:30:00 UTC' /opt/cafe-loyalty/bin/backup.sh production"
check "the nightly backup of a 1st of the month succeeds" "$status" 0
run "FAKE_NOW=@$now /opt/cafe-loyalty/bin/backup.sh production"
check "the nightly backup succeeds" "$status" 0
name=$(vps 'ls /srv/cafe-loyalty/production/backups' | tail -n 1)
check "the backup is named by its UTC time and kind" "$([[ $name =~ ^[0-9]{8}T[0-9]{6}Z-nightly$ ]] && echo named)" named
check "the backup holds the roles and the dump" "$(vps "ls /srv/cafe-loyalty/production/backups/$name | tr '\n' ' '")" "database.dump roles.sql "
check "the backup is readable by root only" "$(vps "stat -c %a /srv/cafe-loyalty/production/backups/$name")" 700
check "the roles carry no passwords" "$(vps "grep -ci 'password\|scram' /srv/cafe-loyalty/production/backups/$name/roles.sql || true")" 0
check "7 nightly backups are kept on the VPS" "$(vps 'ls -d /srv/cafe-loyalty/production/backups/*-nightly | wc -l')" 7
check "the oldest go first" "$(vps 'ls /srv/cafe-loyalty/production/backups | grep nightly | head -n 1')" 20200104T013000Z-nightly
check "no partial files are left" "$(vps 'ls -A /srv/cafe-loyalty/production/backups | grep -c "^\.[0-9]" || true')" 0
check "the copy is off-site, and the 35-day-old one is gone" "$(vps "ls /offsite/production/nightly | tr '\n' ' '")" \
  "20200201T013000Z-nightly.tar.age $name.tar.age recent.tar.age "
check "the 1st of the month's copy is also a monthly one, and monthly copies are kept a year" \
  "$(vps "ls /offsite/production/monthly | tr '\n' ' '")" "20200201T013000Z-nightly.tar.age old.tar.age "
check "no other day's copy is a monthly one" "$(vps "ls /offsite/production/monthly | grep -c $name || true")" 0
check "the off-site copy is age-encrypted" "$(vps "head -c 21 /offsite/production/nightly/$name.tar.age")" "age-encryption.org/v1"
check "no secret is readable off-site" "$(vps "grep -c $APP_SECRET /offsite/production/nightly/$name.tar.age || true")" 0
check "the copy decrypts to the backup and the environment's settings" \
  "$(vps "age -d -i /root/identity.txt /offsite/production/nightly/$name.tar.age | tar -tf - | sort | tr '\n' ' '")" \
  "$name/ $name/app.env $name/database.dump $name/database.env $name/roles.sql "

run "FAKE_NOW=@$now /opt/cafe-loyalty/bin/backup.sh production predeploy"
check "the pre-deploy backup succeeds" "$status" 0
predeploy=$(vps 'ls /srv/cafe-loyalty/production/backups | grep predeploy' | tail -n 1)
check "3 pre-deploy backups are kept on the VPS" "$(vps "ls /srv/cafe-loyalty/production/backups | grep predeploy | tr '\n' ' '")" \
  "20200103T020000Z-predeploy 20200104T020000Z-predeploy $predeploy "
check "pre-deploy copies are kept off-site 14 days" "$(vps "ls /offsite/production/predeploy | tr '\n' ' '")" \
  "$predeploy.tar.age recent.tar.age "

run '/opt/cafe-loyalty/bin/restore-test.sh production'
check "the restore test passes" "$status" 0
check "it reports the restored rows" "$([[ $output == *'migrations, rows:'*'cafes 2'* ]] && echo reported)" reported
check "the throwaway database is removed" "$(docker ps -aq --filter name=cafe-loyalty-restore-test-production)" ""
vps "cp -a /srv/cafe-loyalty/production/backups/$name /srv/cafe-loyalty/production/backups/20991231T000000Z-predeploy
  truncate -s 4096 /srv/cafe-loyalty/production/backups/20991231T000000Z-predeploy/database.dump"
run '/opt/cafe-loyalty/bin/restore-test.sh production 20991231T000000Z-predeploy'
check "a damaged backup fails the restore test" "$status" 1
vps "rm -r /srv/cafe-loyalty/production/backups/20991231T000000Z-predeploy"
vps "mv /srv/cafe-loyalty/production/backups/$name /root/$name"
run '/opt/cafe-loyalty/bin/restore-test.sh production'
check "a stale newest nightly backup fails the restore test" "$status" 1
check "the failure says why" "$([[ $output == *'hours old'* ]] && echo said)" said
vps "mv /root/$name /srv/cafe-loyalty/production/backups/$name"
vps "mv /offsite/production/nightly/$name.tar.age /root/"
run '/opt/cafe-loyalty/bin/restore-test.sh production'
check "a newest nightly backup missing off-site fails the restore test" "$status" 1
check "that failure says why" "$([[ $output == *'is not in /offsite'* ]] && echo said)" said
vps "mv /root/$name.tar.age /offsite/production/nightly/"

# The README's recovery, after losing the database: decrypt the off-site copy where the identity is, then restore.
vps "age -d -i /root/identity.txt /offsite/production/nightly/$name.tar.age | tar -xf - -C /root"
check "the recovered app.env is the environment's" "$(vps "cat /root/$name/app.env")" "PHONE_LOOKUP_PEPPER=$APP_SECRET"
sql "SELECT 1" >/dev/null
docker exec "$NAME-postgres" dropdb -U postgres --force cafe_loyalty
vps "docker exec -i \$(docker ps -q --filter label=com.docker.compose.project=$NAME-production --filter label=com.docker.compose.service=postgres) \
  pg_restore -U postgres --create --exit-on-error -d postgres </root/$name/database.dump"
check "the recovered database has its cafés" "$(sql 'SELECT count(*) FROM app.cafes')" 2
check "the app role still sees none without a café" "$(sql 'SET ROLE cl_app; SELECT count(*) FROM app.cafes')" 0
check "the app role may still connect, and nobody else" \
  "$(sql "SELECT has_database_privilege('cafe_loyalty_app', 'cafe_loyalty', 'CONNECT'), has_database_privilege('public', 'cafe_loyalty', 'CONNECT')")" "t|f"

# The failure alert as systemd runs it (OnFailure= of both services), with the units and curl configuration
# provision.sh generates, POSTing to an HTTPS listener with a certificate the VPS stand-in trusts.
vps "set -e
  openssl req -x509 -newkey rsa:2048 -nodes -keyout /certs/alert.key -out /certs/alert.crt -days 1 -subj /CN=alert.example.test \
    -addext subjectAltName=DNS:alert.example.test 2>/dev/null
  chmod 0644 /certs/alert.key
  cp /certs/alert.crt /usr/local/share/ca-certificates/alert-test.crt && update-ca-certificates >/dev/null 2>&1
  install -d -m 0700 /root/units
  BACKUP_AGE_RECIPIENT=\$(age-keygen -y /root/identity.txt) BACKUP_REMOTE=offsite:backups ALERT_URL=https://alert.example.test/cafe \
    bash /deploy/provision.sh units /root/units >/dev/null
  install -m 0600 /root/units/alert.curlrc /etc/cafe-loyalty/alert.curlrc"
docker pull -q "$PYTHON_IMAGE" >/dev/null
docker run -d --name "$NAME-alert" --network "$NAME-net" --network-alias alert.example.test -v "$NAME-certs:/certs:ro" \
  "$PYTHON_IMAGE" python -u -c '
import http.server, ssl
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        print("received", self.path, self.rfile.read(int(self.headers["Content-Length"])).decode())
        self.send_response(200)
        # A complete response, as a real service sends: newer curl fails on a TLS stream that just ends.
        self.send_header("Content-Length", "0")
        self.end_headers()
server = http.server.HTTPServer(("0.0.0.0", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/certs/alert.crt", "/certs/alert.key")
server.socket = context.wrap_socket(server.socket, server_side=True)
print("ready")
server.serve_forever()' >/dev/null
for _ in $(seq 30); do
  [[ $(docker logs "$NAME-alert" 2>&1) == *ready* ]] && break
  sleep 1
done
check "both services alert on failure" \
  "$(vps 'cat /root/units/cafe-loyalty-{backup,restore-test}@.service | grep -cx "OnFailure=cafe-loyalty-alert@%n.service"')" 2
check "the alert address is in no unit" "$(vps 'cat /root/units/*.service | grep -c alert.example.test || true')" 0
check "the alert address is readable by root only" "$(vps 'stat -c %a /root/units/alert.curlrc')" 600
# Expanded by the VPS stand-in's shell, not this one.
# shellcheck disable=SC2016
run 'line=$(sed -n "s/^ExecStart=//p" "/root/units/cafe-loyalty-alert@.service")
  line=${line//%i/cafe-loyalty-backup@production.service}
  eval "${line//%H/vps-test}"'
check "the alert is sent" "$status" 0
sleep 1
check "the alert names the failed unit and the host" "$(docker logs "$NAME-alert" 2>&1 | grep '^received')" \
  "received /cafe cafe-loyalty-backup@production.service failed on vps-test; see journalctl -u cafe-loyalty-backup@production.service"

if ((failures > 0)); then
  echo "$failures backup check(s) failed." >&2
  exit 1
fi
echo "All backup checks passed."
