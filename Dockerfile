# syntax=docker/dockerfile:1
# The release image (README, Deploying): the API server, the worker, the database CLIs (bootstrap, migrate) and the
# dashboard and counter builds in web/, which the deploy copies out for Caddy. Built by the release workflow (and by
# deploy/test/deploy.sh) with release-commits.txt in the context: `git rev-list HEAD`, the release's history, which
# the next deploy's migration gate reads. No secret is a build argument or in a layer (AC 48): every setting comes from
# the environment's app.env or database.env when a container starts.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS build
RUN corepack enable pnpm
WORKDIR /app
# Dependencies from the lockfile alone, so a source change reuses this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile
# The release's commit and its commit time (UTC), the same for the server and the counter build (AC 26).
ARG BUILD_ID BUILT_AT
RUN [ -n "$BUILD_ID" ] && [ -n "$BUILT_AT" ] && head -n 1 release-commits.txt | grep -qx "$BUILD_ID" \
  || { echo "Set BUILD_ID to the release commit and BUILT_AT to its time, with release-commits.txt from git rev-list HEAD." >&2; exit 1; }
RUN pnpm build
# Only what runs: the server's and worker's production dependencies, their builds, and the two web builds.
RUN mkdir web && mv apps/dashboard/dist web/dashboard && mv apps/counter/dist web/counter \
  && rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/counter apps/dashboard \
  && pnpm install --offline --frozen-lockfile --prod --filter "@cafe-loyalty/server..." --filter "@cafe-loyalty/worker..." \
  && rm -rf apps/server/src apps/server/sync-fixtures apps/worker/src packages/db/src packages/shared/src packages/ui/src/*.ts deploy

FROM ${NODE_IMAGE}
# Debian's security updates released since the base image, and without npm, corepack and yarn, which come with the image but
# never run here, so their dependencies' flaws are not shipped (the release workflow's scan refuses known fixed ones).
RUN apt-get update -q && apt-get upgrade -yq && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /app /app
ARG BUILD_ID BUILT_AT SOURCE_URL
ENV NODE_ENV=production BUILD_ID=${BUILD_ID} BUILT_AT=${BUILT_AT}
LABEL org.opencontainers.image.revision=${BUILD_ID} org.opencontainers.image.created=${BUILT_AT} org.opencontainers.image.source=${SOURCE_URL}
USER node
CMD ["node", "apps/server/dist/main.js"]
