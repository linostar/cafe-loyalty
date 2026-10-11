#!/usr/bin/env bash
# Runs one of the VPS's release scripts as the deploy user over SSH, for the release workflow: `remote.sh <script>
# <argument>…`, such as `remote.sh deploy.sh staging <commit> <digest>`. Reads DEPLOY_HOST, DEPLOY_USER,
# DEPLOY_SSH_KEY (the private key) and DEPLOY_KNOWN_HOSTS (the VPS's host key line) from the environment, which the
# workflow fills from the GitHub environment's secrets and variables; the key's forced command on the VPS
# (ssh-command.sh) runs only that environment's deploy.sh or rollback.sh. One connection per call (the VPS's firewall limits new SSH
# connections); exits with the script's status.
set -euo pipefail

for name in DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS; do
  [[ -n ${!name:-} ]] || { echo "remote: set $name (README, Deploying)." >&2; exit 2; }
done
(($# >= 1)) || { echo "usage: remote.sh <script> <argument>…" >&2; exit 2; }
# The remote shell reads the command line: plain words only.
for arg in "$@"; do
  [[ $arg =~ ^[A-Za-z0-9._:-]+$ ]] || { echo "remote: refusing an argument with other characters than letters, digits and ._:-" >&2; exit 2; }
done
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" >"$dir/key"
chmod 600 "$dir/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" >"$dir/known_hosts"
ssh -i "$dir/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$dir/known_hosts" \
  -o ConnectTimeout=30 -o ServerAliveInterval=30 "$DEPLOY_USER@$DEPLOY_HOST" sudo "/opt/cafe-loyalty/bin/$1" "${@:2}"
