# The VPS's tools for deploy/test/backup.sh and deploy/test/deploy.sh: Ubuntu with the packages provision.sh installs
# that the backup and deploy scripts and the failure alert use, a Docker client (with Compose) for the host's daemon,
# and the release's own sudo (sudo-rs on 26.04) for the deploy user's sudoers rule. Ubuntu 24.04 unless the tests are
# run with RUNNER_UBUNTU=26.04 (deploy/test/runner.sh).
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
FROM ${UBUNTU_IMAGE}
RUN . /etc/os-release && if [ "$VERSION_ID" = 26.04 ]; then sudo=sudo-rs; else sudo=sudo; fi && apt-get update -q && \
  apt-get install -yq --no-install-recommends age ca-certificates curl openssh-client openssl rclone "$sudo" && rm -rf /var/lib/apt/lists/*
COPY --from=docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
