#!/usr/bin/env bash
# The forced command of each deploy key (provision.sh writes `command="ssh-command.sh <environment>"` on its line), so
# an environment's key runs only `sudo /opt/cafe-loyalty/bin/deploy.sh <environment> …` or `rollback.sh <environment>
# …` for its own environment: the staging key, which staging's GitHub environment holds without approval, cannot
# deploy to production. Reads the command the client sent from SSH_ORIGINAL_COMMAND; deploy/ci/remote.sh sends it.
set -euo pipefail

refuse() {
  echo "ssh-command: this key may only run deploy.sh or rollback.sh for ${env:-its environment}: $*" >&2
  exit 2
}
env=${1:-}
[[ $# -eq 1 && ($env == production || $env == staging) ]] || refuse "the key's command in authorized_keys is wrong."
# Split on spaces only; read never expands globs.
read -r -a words <<<"${SSH_ORIGINAL_COMMAND:-}"
((${#words[@]} >= 3)) || refuse "no command given."
[[ ${words[0]} == sudo && ${words[1]} =~ ^/opt/cafe-loyalty/bin/(deploy|rollback)\.sh$ ]] || refuse "another command was given."
[[ ${words[2]} == "$env" ]] || refuse "another environment was given."
for word in "${words[@]:3}"; do
  [[ $word =~ ^[0-9a-z:]+$ ]] || refuse "an argument has other characters than lowercase letters, digits and :."
done
exec sudo "${words[1]}" "${words[@]:2}"
