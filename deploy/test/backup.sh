#!/usr/bin/env bash
# Runs deploy/backup.sh and deploy/restore-test.sh as on the VPS (`pnpm test:deploy`, part of `pnpm test`; needs Docker
# and the built db package): as root in an Ubuntu 24.04 container with the VPS's age and rclone, against a PostgreSQL
# container labelled as a Compose project's `postgres` service and bootstrapped and migrated by the real CLIs. A local
# directory stands in for the off-site remote, and the test holds the age identity the VPS never has, to check the
# encrypted copy. Also walks the README's recovery: decrypt, extract, restore over a lost database. Fake data only.
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

cleanup() {
  docker rm -f -v "$NAME-postgres" "$NAME-runner" cafe-loyalty-restore-test-production >/dev/null 2>&1 || true
  docker volume rm "$NAME-data" >/dev/null 2>&1 || true
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

docker build -q -t cafe-loyalty-deploy-test -f "$DEPLOY_DIR/test/runner.Dockerfile" "$DEPLOY_DIR/test" >/dev/null

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

docker run -d --name "$NAME-runner" -v /var/run/docker.sock:/var/run/docker.sock -v "$DEPLOY_DIR:/deploy:ro" \
  cafe-loyalty-deploy-test sleep infinity >/dev/null
vps "set -e
  install -d -m 0755 /srv/cafe-loyalty /etc/cafe-loyalty /opt/cafe-loyalty/bin
  install -m 0755 /deploy/backup.sh /deploy/restore-test.sh /opt/cafe-loyalty/bin/
  for env in production staging; do
    install -d -m 0700 /srv/cafe-loyalty/\$env/backups
    echo COMPOSE_PROJECT_NAME=$NAME-\$env >/srv/cafe-loyalty/\$env/.env
    printf '%s\n' POSTGRES_USER=postgres POSTGRES_PASSWORD=$POSTGRES_PASSWORD DATABASE_NAME=cafe_loyalty >/srv/cafe-loyalty/\$env/database.env
    echo PHONE_LOOKUP_PEPPER=$APP_SECRET >/srv/cafe-loyalty/\$env/app.env
  done
  age-keygen -o /root/identity.txt 2>/dev/null
  printf '%s\n' BACKUP_AGE_RECIPIENT=\$(age-keygen -y /root/identity.txt) BACKUP_REMOTE=/offsite >/etc/cafe-loyalty/backup.conf
  # Older backups for the retention policy: 8 nightly on the VPS, and off-site copies of several ages.
  for day in 1 2 3 4 5 6 7 8; do mkdir -m 0700 /srv/cafe-loyalty/production/backups/2020010\${day}T013000Z-nightly; done
  mkdir -p /offsite/production/nightly /offsite/production/monthly
  touch -d '40 days ago' /offsite/production/nightly/old.tar.age
  touch -d '20 days ago' /offsite/production/nightly/recent.tar.age
  touch -d '100 days ago' /offsite/production/monthly/old.tar.age"

run '/opt/cafe-loyalty/bin/backup.sh prod'
check "a usage error for an unknown environment" "$status" 1
run '/opt/cafe-loyalty/bin/backup.sh production nightly x'
check "a usage error for an extra argument" "$status" 1
run '/opt/cafe-loyalty/bin/restore-test.sh production ../../etc'
check "a usage error for a backup name that is a path" "$status" 1
run '/opt/cafe-loyalty/bin/backup.sh staging'
check "an environment never deployed is skipped" "$status" 0
check "the skip says why" "$([[ $output == *'nothing to back up'* ]] && echo said)" said

run '/opt/cafe-loyalty/bin/backup.sh production'
check "the nightly backup succeeds" "$status" 0
name=$(vps 'ls /srv/cafe-loyalty/production/backups' | tail -n 1)
check "the backup is named by its UTC time and kind" "$([[ $name =~ ^[0-9]{8}T[0-9]{6}Z-nightly$ ]] && echo named)" named
check "the backup holds the roles and the dump" "$(vps "ls /srv/cafe-loyalty/production/backups/$name | tr '\n' ' '")" "database.dump roles.sql "
check "the backup is readable by root only" "$(vps "stat -c %a /srv/cafe-loyalty/production/backups/$name")" 700
check "the roles carry no passwords" "$(vps "grep -ci 'password\|scram' /srv/cafe-loyalty/production/backups/$name/roles.sql || true")" 0
check "7 nightly backups are kept on the VPS" "$(vps 'ls -d /srv/cafe-loyalty/production/backups/*-nightly | wc -l')" 7
check "the oldest go first" "$(vps 'ls /srv/cafe-loyalty/production/backups | head -n 1')" 20200103T013000Z-nightly
check "no partial files are left" "$(vps 'ls -A /srv/cafe-loyalty/production/backups | grep -c "^\.[0-9]" || true')" 0
check "the copy is off-site" "$(vps "ls /offsite/production/nightly | tr '\n' ' '")" "$name.tar.age recent.tar.age "
check "monthly copies are kept a year" "$(vps 'ls /offsite/production/monthly')" old.tar.age
check "the off-site copy is age-encrypted" "$(vps "head -c 21 /offsite/production/nightly/$name.tar.age")" "age-encryption.org/v1"
check "no secret is readable off-site" "$(vps "grep -c $APP_SECRET /offsite/production/nightly/$name.tar.age || true")" 0
check "the copy decrypts to the backup and the environment's settings" \
  "$(vps "age -d -i /root/identity.txt /offsite/production/nightly/$name.tar.age | tar -tf - | sort | tr '\n' ' '")" \
  "$name/ $name/app.env $name/database.dump $name/database.env $name/roles.sql "

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

if ((failures > 0)); then
  echo "$failures backup check(s) failed." >&2
  exit 1
fi
echo "All backup checks passed."
