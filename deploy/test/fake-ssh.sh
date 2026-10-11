#!/usr/bin/env bash
# Stands in for ssh and sshd in deploy/test/deploy.sh (installed as the runner's ssh): takes deploy/ci/remote.sh's
# options, finds the line of the -i key in the authorized_keys provision.sh generated, and runs that line's forced
# command with the words after the destination in SSH_ORIGINAL_COMMAND, joined by spaces, as ssh and sshd do.
set -euo pipefail

key='' words=()
while (($# > 0)); do
  case $1 in
  -i) key=$2 && shift 2 ;;
  -o) shift 2 ;;
  *) words+=("$1") && shift ;;
  esac
done
public=$(ssh-keygen -y -f "$key" | cut -d ' ' -f 2)
line=$(grep -F " $public" /etc/ssh/authorized_keys/deploy) || { echo "Permission denied (publickey)." >&2; exit 255; }
forced=$(sed -n 's/^restrict,command="\([^"]*\)" .*/\1/p' <<<"$line")
[[ -n $forced ]] || { echo "fake-ssh: the key's line has no forced command." >&2; exit 255; }
SSH_ORIGINAL_COMMAND="${words[*]:1}" exec bash -c "$forced"
