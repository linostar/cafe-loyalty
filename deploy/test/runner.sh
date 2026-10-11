#!/usr/bin/env bash
# Sourced by deploy/test/{backup,caddy,deploy}.sh: builds the VPS stand-in (runner.Dockerfile) for the Ubuntu release
# in RUNNER_UBUNTU (24.04, the default, or 26.04: the releases provision.sh supports) and sets RUNNER to its image.
case ${RUNNER_UBUNTU:-24.04} in
24.04) runner_base=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 ;;
26.04) runner_base=ubuntu:26.04@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7 ;;
*)
  echo "RUNNER_UBUNTU must be 24.04 or 26.04." >&2
  exit 1
  ;;
esac
RUNNER=cafe-loyalty-deploy-test:ubuntu-${RUNNER_UBUNTU:-24.04}
readonly RUNNER
docker build -q -t "$RUNNER" --build-arg "UBUNTU_IMAGE=$runner_base" -f "$(dirname "${BASH_SOURCE[0]}")/runner.Dockerfile" \
  "$(dirname "${BASH_SOURCE[0]}")" >/dev/null
