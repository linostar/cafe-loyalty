#!/usr/bin/env bash
# Sets up a fresh Ubuntu VPS to run Cafe Loyalty's production and staging environments, and brings an existing one back
# to this setup: run it again after any change here or in deploy/. Run as root on the VPS, from a copy of this
# repository's deploy/ directory, with every setting in the environment (see deploy/provision.conf.example and the
# README's "Provisioning the VPS"). It never prints a secret and never replaces one it generated before.
#
# For tests (no root, any machine with bash): `provision.sh caddyfile` prints the Caddy configuration and
# `provision.sh env-files <dir>` writes a production environment's database.env and app.env into <dir>, both from the
# *_DOMAIN settings.
set -euo pipefail

readonly APP=cafe-loyalty
readonly OPT_DIR=/opt/$APP
readonly BIN_DIR=$OPT_DIR/bin
readonly SRV_DIR=/srv/$APP
readonly ENVIRONMENTS=(production staging)
# Primary key fingerprint of Docker's apt repository signing key, as Docker publishes it.
readonly DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
# Caddy runs from its official image (multi-arch index digest); bump both together to upgrade it.
readonly CADDY_IMAGE=caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
readonly EDGE_DIR=$OPT_DIR/edge
# Settings generated per environment, which must never be the same in production and staging.
readonly GENERATED_SECRETS=(POSTGRES_PASSWORD MIGRATOR_PASSWORD APP_PASSWORD PHONE_LOOKUP_PEPPER PHONE_ENCRYPTION_KEYS CARD_QR_KEYS)
# Settings the operator fills in per environment; the same value in both is refused, like a generated secret.
readonly OPERATOR_SECRETS=(SMTP_PASSWORD APPLE_PASS_KEY GOOGLE_WALLET_SERVICE_ACCOUNT)

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

fail() {
  echo "provision: $*" >&2
  exit 1
}
log() { echo "provision: $*"; }

# Installs stdin at $1 with mode $2 (owner root) unless it already has that content; returns 1 when nothing changed.
# Callers test its status, which turns off `set -e` inside it, so every step fails explicitly.
put_file() {
  local path=$1 mode=$2 temp
  temp=$(mktemp "$(dirname "$path")/.provision.XXXXXX") || fail "cannot write in $(dirname "$path")."
  cat >"$temp" || fail "cannot write $temp."
  chmod "$mode" "$temp" || fail "cannot change the mode of $temp."
  # GNU stat, or BSD stat for the test modes on macOS.
  if [[ -f $path ]] && cmp -s "$temp" "$path" && [[ $(stat -c %a "$path" 2>/dev/null || stat -f %Lp "$path") == "$mode" ]]; then
    rm -f "$temp"
    return 1
  fi
  mv "$temp" "$path" || fail "cannot replace $path."
  log "wrote $path"
}

# Loopback port environment $1's Compose project publishes its API server on; Caddy proxies to it.
proxy_port() {
  case $1 in
  production) echo 3100 ;;
  staging) echo 3200 ;;
  esac
}

# The upper-case form of $1 (bash 3 has no ${var^^}).
upper() { tr '[:lower:]' '[:upper:]' <<<"$1"; }

# The value of setting $2 in env file $1 (empty when unset).
env_value() { sed -n "s/^$2=//p" "$1" | tail -n 1; }

check_input() {
  [[ $EUID -eq 0 ]] || fail "run as root: sudo bash -c 'set -a && . ./provision.conf && set +a && ./provision.sh'."
  # Sets ID and VERSION_CODENAME, among others.
  # shellcheck source=/dev/null
  . /etc/os-release
  [[ $ID == ubuntu ]] || fail "this script supports Ubuntu only."

  local missing=() name
  for name in DEPLOY_USER DEPLOY_SSH_PUBLIC_KEY {PRODUCTION,STAGING}_{DASHBOARD,COUNTER,PUBLIC}_DOMAIN; do
    [[ -n ${!name:-} ]] || missing+=("$name")
  done
  ((${#missing[@]} == 0)) || fail "set ${missing[*]} (see deploy/provision.conf.example)."

  [[ $DEPLOY_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ && $DEPLOY_USER != root ]] ||
    fail "DEPLOY_USER must be a new or existing non-root user name (lowercase letters, digits, - and _)."
  local key_help="DEPLOY_SSH_PUBLIC_KEY must be one OpenSSH public key line (the contents of a .pub file)."
  [[ $DEPLOY_SSH_PUBLIC_KEY != *$'\n'* ]] || fail "$key_help"
  ssh-keygen -l -f - <<<"$DEPLOY_SSH_PUBLIC_KEY" >/dev/null 2>&1 || fail "$key_help"
  check_domains

  # Password logins end below, so whoever runs this must already be able to log in with a key.
  local admin=${SUDO_USER:-root} admin_home
  admin_home=$(getent passwd "$admin" | cut -d: -f6)
  [[ $admin != "$DEPLOY_USER" ]] || fail "run this as an administrator, not as $DEPLOY_USER."
  [[ -s $admin_home/.ssh/authorized_keys ]] ||
    fail "$admin has no $admin_home/.ssh/authorized_keys: add your SSH key first, or this would lock you out."
}

check_domains() {
  local domains=() domain name
  for name in {PRODUCTION,STAGING}_{DASHBOARD,COUNTER,PUBLIC}_DOMAIN; do
    domain=${!name}
    [[ $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail "$name must be a lowercase domain name such as app.example.com."
    domains+=("$domain")
  done
  [[ $(printf '%s\n' "${domains[@]}" | sort -u | wc -l) -eq ${#domains[@]} ]] ||
    fail "the six *_DOMAIN settings must all differ: each app of each environment has its own domain."
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -yq ca-certificates curl gnupg openssl ufw unattended-upgrades
  install -d -m 0755 /etc/apt/keyrings
  local arch codename=$VERSION_CODENAME
  arch=$(dpkg --print-architecture)
  add_repository docker https://download.docker.com/linux/ubuntu/gpg "$DOCKER_KEY_FINGERPRINT" \
    "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable"
  apt-get update -q
  # In place before Docker is installed or upgraded, so its daemon starts with live-restore: an upgrade or restart of
  # Docker then leaves the containers running.
  write_docker_config
  # A daemon already running takes live-restore now, before the upgrade below restarts it.
  if systemctl is-active --quiet docker; then systemctl reload docker; fi
  # Upgrades Docker too on every run: unattended upgrades take security updates from Ubuntu only.
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

# Adds apt repository $1: key URL $2, whose primary key must have fingerprint $3, and source line $4.
add_repository() {
  local name=$1 key_url=$2 fingerprint=$3 source=$4 key
  key=$(mktemp)
  curl -fsSL --max-time 60 "$key_url" -o "$key"
  # Exactly one key, the expected one: apt would trust every key in the file.
  [[ $(gpg --show-keys --with-colons "$key" | awk -F: '$1 == "pub" { n++ } $1 == "fpr" && !f { f = $10 } END { print n ":" f }') == "1:$fingerprint" ]] ||
    fail "the $name signing key at $key_url is not the one key with fingerprint $fingerprint."
  put_file "/etc/apt/keyrings/$name.asc" 644 <"$key" || true
  rm -f "$key"
  put_file "/etc/apt/sources.list.d/$name.list" 644 <<<"$source" || true
}

# Published ports bind to loopback unless a Compose file names another address (Docker's own rules bypass ufw), every
# container's log is rotated, and containers keep running while the daemon restarts or upgrades (live-restore).
write_docker_config() {
  install -d -m 0755 /etc/docker
  put_file /etc/docker/daemon.json 644 <<'EOF' || true
{
  "ip": "127.0.0.1",
  "live-restore": true,
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
}

# Restarts the daemon when its settings file is newer than the running daemon (so a run that stopped half way is
# finished by the next), never stopping containers: with live-restore off in the running daemon, a reload turns it on
# first.
configure_docker() {
  systemctl enable --now docker >/dev/null
  local started
  started=$(date -d "$(systemctl show docker -p ActiveEnterTimestamp --value)" +%s)
  ((started >= $(stat -c %Y /etc/docker/daemon.json))) && return 0
  if [[ $(docker info --format '{{.LiveRestoreEnabled}}') != true ]]; then
    systemctl reload docker
    [[ $(docker info --format '{{.LiveRestoreEnabled}}') == true || -z $(docker ps -q) ]] ||
      fail "Docker did not turn on live-restore, so restarting it would stop the running containers; check journalctl -u docker."
  fi
  systemctl restart docker
  log "restarted Docker with /etc/docker/daemon.json"
}

configure_ssh() {
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    # No password: the account logs in only with the key below.
    useradd --create-home --shell /bin/bash --user-group "$DEPLOY_USER"
    log "created user $DEPLOY_USER"
  fi
  local group
  for group in sudo admin docker wheel; do
    if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -x "$group" >/dev/null; then
      fail "$DEPLOY_USER is in the $group group, which gives root; remove it (gpasswd -d $DEPLOY_USER $group) and run again."
    fi
  done
  # The deploy user's only key, in a file only root can change (sshd reads it through the Match below); root never
  # touches the user's home, where a symlink could turn a write into a takeover. `restrict` turns off forwarding,
  # terminals and the agent, so the key can run commands only.
  install -d -m 0755 /etc/ssh/authorized_keys
  put_file "/etc/ssh/authorized_keys/$DEPLOY_USER" 644 <<<"restrict $DEPLOY_SSH_PUBLIC_KEY" || true

  # The deploy user may run, as root, only the scripts this installs in $BIN_DIR (a directory only root can write).
  local sudoers
  sudoers=$(mktemp)
  echo "$DEPLOY_USER ALL=(root) NOPASSWD: $BIN_DIR/" >"$sudoers"
  chmod 440 "$sudoers"
  visudo -cqf "$sudoers" || fail "the sudoers rule for $DEPLOY_USER is invalid."
  put_file /etc/sudoers.d/$APP-deploy 440 <"$sudoers" || true
  rm -f "$sudoers"

  # Read before the image's own drop-ins (sshd keeps the first value it reads), so cloud-init cannot turn passwords on.
  # A configuration sshd refuses is taken back at once: left in place, sshd would not start after the next reboot.
  local conf=/etc/ssh/sshd_config.d/00-$APP.conf previous
  previous=$(mktemp)
  [[ -f $conf ]] && cp "$conf" "$previous"
  if put_file "$conf" 644 <<EOF; then
# Written by deploy/provision.sh. Key logins only.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
X11Forwarding no

Match User $DEPLOY_USER
	AuthorizedKeysFile /etc/ssh/authorized_keys/%u
EOF
    local refused
    if ! refused=$(sshd -t 2>&1); then
      if [[ -s $previous ]]; then mv "$previous" "$conf"; else rm -f "$conf"; fi
      fail "sshd refused its configuration, so $conf is back as it was and sshd was not reloaded. sshd said:
$refused
Fix the file it names and run again."
    fi
    systemctl reload ssh
  fi
  rm -f "$previous"
  # Every run, not only when this file changed: another drop-in can break sshd's next start (after a reboot) too.
  local problem
  problem=$(sshd -t 2>&1) || fail "sshd refuses its configuration, so it would not start after a reboot. sshd said:
$problem
Fix the file it names and run again."
  sshd -T | grep -x "passwordauthentication no" >/dev/null || fail "sshd still accepts passwords; check /etc/ssh/sshd_config."
}

configure_firewall() {
  # Only 22 is opened, so sshd must listen there alone (Ubuntu 24.04 may take the port from ssh.socket instead).
  local ports
  ports=$(sshd -T | awk '$1 == "port" { print $2 }' | sort -u | tr '\n' ' ')
  if systemctl is-active --quiet ssh.socket; then
    ports+=$(systemctl show ssh.socket -p Listen --value | grep -oE ':[0-9]+ \(Stream\)' | tr -dc '0-9\n' | sort -u | tr '\n' ' ')
  fi
  [[ $(tr ' ' '\n' <<<"$ports" | grep . | sort -u) == 22 ]] ||
    fail "sshd listens on port(s) $ports, and the firewall would open only 22; move sshd to port 22 first."
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw limit 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  # 443 over UDP too: Caddy serves HTTP/3.
  ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
  local extra
  extra=$(ufw show added | grep '^ufw ' | grep -vxE 'ufw (limit 22/tcp|allow 80/tcp|allow 443)' || true)
  [[ -z $extra ]] || fail "the firewall has rules this script did not add; delete them (ufw delete …) and run again:
$extra"
}

configure_updates() {
  # Logs, timers and the reboot time below are all in UTC.
  timedatectl set-timezone Etc/UTC
  put_file /etc/apt/apt.conf.d/20auto-upgrades 644 <<'EOF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  # Ubuntu's defaults take security updates only; reboot for a kernel update at night (04:00 or 05:00 in Beirut).
  put_file /etc/apt/apt.conf.d/52$APP-unattended-upgrades 644 <<'EOF' || true
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "02:00";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF
  install -d -m 0755 /etc/systemd/journald.conf.d
  if put_file /etc/systemd/journald.conf.d/$APP.conf 644 <<'EOF'; then
[Journal]
SystemMaxUse=1G
EOF
    systemctl restart systemd-journald
  fi
}

configure_environment() {
  local env=$1
  local dir=$SRV_DIR/$env
  install -d -m 0755 "$dir" "$dir/web" "$dir/web/dashboard" "$dir/web/counter"
  install -d -m 0700 "$dir/backups"

  # Settings for Compose itself (no secrets): the project name keeps each environment's containers, network and volumes
  # apart, and Caddy proxies to the port its server publishes.
  put_file "$dir/.env" 644 <<EOF || true
COMPOSE_PROJECT_NAME=$APP-$env
PROXY_PORT=$(proxy_port "$env")
EOF
  write_env_files "$dir" "$env"
  local file
  for file in "$dir/database.env" "$dir/app.env"; do
    chown root:root "$file"
    chmod 600 "$file"
  done
}

# Writes environment $2's database.env and app.env in directory $1 the first time (generating every secret), and then
# only follows the domains in app.env's addresses.
write_env_files() {
  local dir=$1 env=$2 prefix
  prefix=$(upper "$env")
  local dashboard=${prefix}_DASHBOARD_DOMAIN counter=${prefix}_COUNTER_DOMAIN public=${prefix}_PUBLIC_DOMAIN
  # Generated once and then kept: a new pepper or key would orphan every customer's data, and new database passwords
  # would no longer match the database, which keeps the ones it was created with.
  if [[ ! -f $dir/database.env && -f $dir/app.env ]]; then
    fail "$dir/database.env is missing but app.env is there; restore database.env from a backup of the VPS."
  fi
  if [[ ! -f $dir/database.env ]]; then
    local postgres migrator app
    postgres=$(openssl rand -hex 32) migrator=$(openssl rand -hex 32) app=$(openssl rand -hex 32)
    put_file "$dir/database.env" 600 <<<"# $env database settings, generated by deploy/provision.sh. Only for the PostgreSQL container and its
# one-off bootstrap, migration and backup containers; never copy them to another environment.
LOG_LEVEL=info
POSTGRES_USER=postgres
POSTGRES_PASSWORD=$postgres
POSTGRES_DB=postgres
DATABASE_ADMIN_URL=postgres://postgres:$postgres@postgres:5432/postgres
DATABASE_NAME=cafe_loyalty
MIGRATOR_ROLE=cafe_loyalty_migrator
MIGRATOR_PASSWORD=$migrator
APP_ROLE=cafe_loyalty_app
APP_PASSWORD=$app
MIGRATOR_DATABASE_URL=postgres://cafe_loyalty_migrator:$migrator@postgres:5432/cafe_loyalty" || true
  fi
  if [[ ! -f $dir/app.env ]]; then
    local app_password
    app_password=$(env_value "$dir/database.env" APP_PASSWORD)
    [[ -n $app_password ]] || fail "$dir/database.env has no APP_PASSWORD; restore it from a backup of the VPS."
    put_file "$dir/app.env" 600 <<<"# $env settings for the API server and the worker (see .env.example), generated by deploy/provision.sh.
# Never copy a value to another environment. The release (deploy script) sets BUILT_AT.
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
LOG_LEVEL=info
TRUST_PROXY_HOPS=1
DATABASE_URL=postgres://cafe_loyalty_app:$app_password@postgres:5432/cafe_loyalty
DASHBOARD_URL=
COUNTER_URL=
PUBLIC_URL=
PHONE_LOOKUP_PEPPER=$(openssl rand -base64 32)
PHONE_ENCRYPTION_KEYS=k1:$(openssl rand -base64 32)
CARD_QR_KEYS=k1:$(openssl rand -base64 32)

# Fill in: outgoing email for this environment (its own SMTP account and sender).
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
EMAIL_FROM=

# Optional: this environment's own Apple Wallet (all five) and Google Wallet (both) credentials; see .env.example.
# APPLE_PASS_TYPE_ID=
# APPLE_TEAM_ID=
# APPLE_PASS_CERTIFICATE=
# APPLE_PASS_KEY=
# APPLE_WWDR_CERTIFICATE=
# GOOGLE_WALLET_ISSUER_ID=
# GOOGLE_WALLET_SERVICE_ACCOUNT=" || true
  fi
  # The addresses follow the domains given to this run.
  # Read in full first: a failed read must stop the run, never leave app.env (and its keys) empty.
  local updated
  updated=$(sed -e "s|^DASHBOARD_URL=.*|DASHBOARD_URL=https://${!dashboard}|" -e "s|^COUNTER_URL=.*|COUNTER_URL=https://${!counter}|" \
    -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://${!public}|" "$dir/app.env") || fail "cannot read $dir/app.env."
  [[ -n $updated ]] || fail "$dir/app.env is empty; restore it from a backup of the VPS."
  put_file "$dir/app.env" 600 <<<"$updated" || true
}

# Fails when production and staging share any secret (AC 50), without printing it.
check_environments_apart() {
  local name file shared=()
  for name in "${GENERATED_SECRETS[@]}" "${OPERATOR_SECRETS[@]}"; do
    file=app.env
    [[ $name == *PASSWORD && $name != SMTP_PASSWORD ]] && file=database.env
    local production staging
    production=$(env_value "$SRV_DIR/production/$file" "$name")
    staging=$(env_value "$SRV_DIR/staging/$file" "$name")
    [[ -n $production && $production == "$staging" ]] && shared+=("$name") && continue
    # Keyrings (id:key,…) are compared key by key, so a key copied into the other environment's ring is caught too.
    if [[ $name == *_KEYS && -n $production && -n $staging ]] &&
      comm -12 <(tr ',' '\n' <<<"$production" | cut -d: -f2- | sort) <(tr ',' '\n' <<<"$staging" | cut -d: -f2- | sort) | grep . >/dev/null; then
      shared+=("$name")
    fi
  done
  ((${#shared[@]} == 0)) || fail "production and staging have the same ${shared[*]}; give each environment its own."
}

# Settings each environment still needs before it can start, by name.
report_unset() {
  local env name unset
  for env in "${ENVIRONMENTS[@]}"; do
    unset=()
    for name in SMTP_HOST SMTP_USER SMTP_PASSWORD EMAIL_FROM; do
      [[ -n $(env_value "$SRV_DIR/$env/app.env" "$name") ]] || unset+=("$name")
    done
    ((${#unset[@]} == 0)) || log "$env: fill in ${unset[*]} in $SRV_DIR/$env/app.env (as root)."
  done
}

# The Caddy configuration for every environment, on stdout.
caddyfile_text() {
  local csp env prefix dashboard counter public noindex
  # One line, shared with the dashboard's and counter's preview servers, which the end-to-end tests run under it.
  csp=$(cat "$SCRIPT_DIR/spa-csp.txt")
  [[ -n $csp && $csp != *'"'* && $csp != *$'\n'* ]] || fail "$SCRIPT_DIR/spa-csp.txt must hold one policy line without quotes."
  cat <<'EOF'
# Written by deploy/provision.sh from the *_DOMAIN settings; edits here are replaced on its next run.
# Caddy gets and renews every site's TLS certificate itself. Its access logs never include Cookie or Authorization
# headers (log_credentials stays off).

{
	# Host networking would put the admin API on 127.0.0.1:2019 for every local user; a socket in the container's own
	# volume is reachable only through docker, as root.
	admin unix//config/admin.sock
	# Caddy's own log, error entries included (a 502 while a server restarts logs the request), masked like the access logs.
	log default {
		output stderr
		format filter {
			request>uri regexp [A-Za-z0-9_-]{16,} [redacted]
			request>headers>Referer regexp [A-Za-z0-9_-]{16,} [redacted]
			resp_headers>Location regexp [A-Za-z0-9_-]{16,} [redacted]
		}
	}
}

(access_log) {
	log {
		output file /var/log/caddy/{args[0]}.log {
			roll_size 20MiB
			roll_keep 10
			roll_keep_for 720h
		}
		# Card, recovery and feedback links carry secrets in their paths (/c/, /r/, /f/), and the server's redirects to
		# them (and to Google's save links) in Location: every run of 16 or more URL-safe characters in a logged address
		# is masked, as the server masks secret-like segments in its own logs.
		format filter {
			request>uri regexp [A-Za-z0-9_-]{16,} [redacted]
			request>headers>Referer regexp [A-Za-z0-9_-]{16,} [redacted]
			resp_headers>Location regexp [A-Za-z0-9_-]{16,} [redacted]
		}
	}
}

(security_headers) {
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
}

# A built single-page app (args: environment, app, API port, Content-Security-Policy): /api goes to the server,
# hashed /assets/ files are cached for good, and every other path is the app's index.html; everything but /assets/ (index.html, the counter's
# sw.js) is revalidated on every load, so a release reaches browsers at once.
(spa) {
	import security_headers
	header Content-Security-Policy "{args[3]}"
	header X-Frame-Options DENY
	root * /srv/cafe-loyalty/{args[0]}/web/{args[1]}
	encode zstd gzip
	handle /api/* {
		reverse_proxy 127.0.0.1:{args[2]}
	}
	handle /assets/* {
		# Not on a 404, which a browser would then keep.
		@exists file
		header @exists Cache-Control "public, max-age=31536000, immutable"
		file_server
	}
	handle {
		header Cache-Control no-cache
		try_files {path} /index.html
		file_server
	}
}
EOF
  for env in "${ENVIRONMENTS[@]}"; do
    prefix=$(upper "$env")
    dashboard=${prefix}_DASHBOARD_DOMAIN counter=${prefix}_COUNTER_DOMAIN public=${prefix}_PUBLIC_DOMAIN
    noindex=""
    [[ $env == staging ]] && noindex=$'\n\theader X-Robots-Tag "noindex, nofollow"'
    cat <<EOF

# $env
${!dashboard} {
	import access_log $env-dashboard
	import spa $env dashboard $(proxy_port "$env") "$csp"$noindex
}

${!counter} {
	import access_log $env-counter
	import spa $env counter $(proxy_port "$env") "$csp"$noindex
}

# The server's own pages: customer signup, cards, recovery and feedback, the PassKit web service and its assets.
${!public} {
	import access_log $env-public
	import security_headers$noindex
	reverse_proxy 127.0.0.1:$(proxy_port "$env")
}
EOF
  done
}

configure_caddy() {
  install -d -m 0755 /etc/caddy /var/log/caddy "$EDGE_DIR"
  if ! docker image inspect "$CADDY_IMAGE" >/dev/null 2>&1; then
    timeout 600 docker pull -q "$CADDY_IMAGE" >/dev/null ||
      fail "could not download $CADDY_IMAGE (network or Docker Hub trouble); run this again."
  fi
  local check refused
  check=$(mktemp -d)
  caddyfile_text >"$check/Caddyfile"
  refused=$(docker run --rm --network none -v "$check:/etc/caddy" "$CADDY_IMAGE" \
    sh -c 'caddy fmt --overwrite /etc/caddy/Caddyfile && caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile' 2>&1) ||
    fail "Caddy refused the generated configuration:
$refused"
  put_file /etc/caddy/Caddyfile 644 <"$check/Caddyfile" || true
  rm -rf "$check"

  # Host networking: ufw governs ports 80 and 443 as for any host service, and the servers' loopback ports are in reach.
  # Only the app builds are mounted, never an environment's settings.
  put_file "$EDGE_DIR/compose.yaml" 644 <<EOF || true
# Written by deploy/provision.sh: Caddy for every environment.
name: $APP-edge
services:
  caddy:
    image: $CADDY_IMAGE
    network_mode: host
    restart: unless-stopped
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
    security_opt: ["no-new-privileges:true"]
    volumes:
      - /etc/caddy:/etc/caddy:ro
      - /var/log/caddy:/var/log/caddy
$(for env in "${ENVIRONMENTS[@]}"; do echo "      - $SRV_DIR/$env/web:$SRV_DIR/$env/web:ro"; done)
      - data:/data
      - config:/config
volumes:
  data:
  config:
EOF
  local edge=(docker compose -f "$EDGE_DIR/compose.yaml") logs="docker compose -f $EDGE_DIR/compose.yaml logs caddy"
  "${edge[@]}" up -d --quiet-pull --wait || fail "Caddy did not start; see $logs."
  # Always, not only when this run changed the file, so a run that stopped half way is finished by the next (an
  # unchanged configuration reloads as a no-op). Retried while a just-started Caddy opens its admin socket.
  local tries=0 output
  until output=$("${edge[@]}" exec -T caddy \
    caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile --address unix//config/admin.sock 2>&1); do
    ((++tries < 15)) || fail "Caddy is not running /etc/caddy/Caddyfile ($logs). Its last words:
$("${edge[@]}" logs --tail 5 caddy 2>&1)
$output"
    sleep 2
  done
  local port
  for port in 80 443; do
    [[ $(ss -Hltnp "sport = :$port") == *'"caddy"'* ]] ||
      fail "Caddy is not listening on port $port (another service may hold it: ss -ltnp 'sport = :$port'); see $logs."
  done
  [[ $(ss -Hlunp "sport = :443") == *'"caddy"'* ]] ||
    fail "Caddy is not listening on UDP port 443 for HTTP/3 (ss -lunp 'sport = :443'); see $logs."
}

install_scripts() {
  install -d -m 0755 "$OPT_DIR" "$BIN_DIR"
  local script name
  # Every script next to this one but itself (provisioning stays with administrators).
  for script in "$SCRIPT_DIR"/*.sh; do
    name=$(basename "$script")
    [[ $name == provision.sh ]] && continue
    put_file "$BIN_DIR/$name" 755 <"$script" || true
  done
  for script in "$BIN_DIR"/*; do
    [[ -e $script ]] || continue
    name=$(basename "$script")
    if [[ $name == provision.sh || ! -f $SCRIPT_DIR/$name ]]; then
      rm -f "$script"
      log "removed $script"
    fi
  done
}

configure_timers() {
  local changed=0
  put_file /etc/systemd/system/$APP-backup@.service 644 <<EOF && changed=1
[Unit]
Description=Cafe Loyalty backup (%i)
# Skipped until deploy/backup.sh exists and this script has installed it.
ConditionFileIsExecutable=$BIN_DIR/backup.sh
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=$BIN_DIR/backup.sh %i
EOF
  put_file /etc/systemd/system/$APP-backup@.timer 644 <<'EOF' && changed=1
[Unit]
Description=Nightly Cafe Loyalty backup (%i)

[Timer]
OnCalendar=*-*-* 01:30:00 UTC
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  put_file /etc/systemd/system/$APP-restore-test@.service 644 <<EOF && changed=1
[Unit]
Description=Cafe Loyalty restore test (%i)
# Skipped until deploy/restore-test.sh exists and this script has installed it.
ConditionFileIsExecutable=$BIN_DIR/restore-test.sh
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=$BIN_DIR/restore-test.sh %i
EOF
  put_file /etc/systemd/system/$APP-restore-test@.timer 644 <<'EOF' && changed=1
[Unit]
Description=Monthly Cafe Loyalty restore test (%i)

[Timer]
OnCalendar=*-*-01 03:00:00 UTC
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  ((changed == 0)) || systemctl daemon-reload
  local env
  for env in "${ENVIRONMENTS[@]}"; do
    systemctl enable --now "$APP-backup@$env.timer" "$APP-restore-test@$env.timer" 2>/dev/null ||
      fail "cannot start the $env backup and restore test timers (systemctl status $APP-backup@$env.timer)."
  done
}

main() {
  check_input
  install_packages
  configure_docker
  configure_ssh
  configure_firewall
  configure_updates
  local env
  for env in "${ENVIRONMENTS[@]}"; do
    configure_environment "$env"
  done
  check_environments_apart
  configure_caddy
  install_scripts
  configure_timers
  report_unset
  log "done."
}

case ${1:-} in
"") main ;;
caddyfile) check_domains && caddyfile_text ;;
env-files) [[ -d ${2:-} ]] || fail "usage: $0 env-files <existing directory>"; check_domains && write_env_files "$2" production ;;
*) fail "usage: $0 [caddyfile | env-files <directory>]" ;;
esac
