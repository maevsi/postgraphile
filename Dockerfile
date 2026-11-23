# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

# <DEPENDENCIES>
FROM ghcr.io/maevsi/sqitch:13.11.0@sha256:954a63391f8b08d6b055b0fe130b4c8dc258cbee24ab4d744e7cb3ad6a842e06
# </DEPENDENCIES>

########################
# Create base.

FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base

# The `CI` environment variable must be set for pnpm to run in headless mode
ENV CI=true

WORKDIR /srv/app/

# tini forwards stop signals, which the pnpm wrapper on PID 1 does not pass on.
RUN apk add --no-cache tini \
    && npm i -g pnpm


########################
# Serve development.

FROM base AS development

ENV GRAPHILE_ENV=development

RUN mkdir \
      /srv/.pnpm-store \
      /srv/app/node_modules \
    && chown node:node \
      /srv/.pnpm-store \
      /srv/app/node_modules
VOLUME /srv/.pnpm-store
VOLUME /srv/app
VOLUME /srv/app/node_modules

USER node
ENTRYPOINT ["/sbin/tini", "--", "/srv/app/docker-entrypoint.sh"]
CMD ["pnpm", "exec", "postgraphile", "--config", "./src/graphile.config.ts"]
EXPOSE 5678
HEALTHCHECK --start-period=300s CMD RESPONSE=$(wget -q -O- --header='Content-Type: application/json' --post-data='{"query":"query health { __schema { queryType { name } } }"}' "http://127.0.0.1:${POSTGRAPHILE_PORT:-5678}/graphql") && echo "$RESPONSE" | grep -q '"queryType"' && ! echo "$RESPONSE" | grep -q '"errors"' || exit 1


########################
# Prepare environment.

FROM base AS prepare

COPY ./package.json ./pnpm-lock.yaml ./pnpm-workspace.yaml ./
# vendor/ holds local tarball deps (currently graphile/crystal#3109, see
# pnpm-workspace.yaml `overrides`) - unlike registry/git deps, `pnpm fetch`
# needs these present on disk already, it can't fetch a `file:` spec.
COPY ./vendor ./vendor

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch

COPY ./ ./

RUN pnpm install --offline


########################
# Lint code.

FROM prepare AS lint

RUN pnpm run lint


########################
# Build for production.

FROM prepare AS build

RUN pnpm install --offline --prod


########################
# Collect results.

FROM base AS collect

RUN chown node:node .

COPY --from=prepare --chown=node /srv/app/src ./src
COPY --from=prepare --chown=node /srv/app/docker-entrypoint.sh /srv/app/package.json /srv/app/pnpm-workspace.yaml ./
COPY --from=build --chown=node /srv/app/node_modules ./node_modules
COPY --from=build --chown=node /srv/app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=lint --chown=node /srv/app/package.json /dev/null


########################
# Serve production.

FROM collect AS production

ENV NODE_ENV=production

USER node

# Download the pinned pnpm version as `node` user, as the global one only switches to it on first use.
RUN pnpm --version

ENTRYPOINT ["/sbin/tini", "--", "/srv/app/docker-entrypoint.sh"]
CMD ["pnpm", "exec", "postgraphile", "--config", "./src/graphile.config.ts"]
EXPOSE 5678
HEALTHCHECK --interval=10s --timeout=5s CMD RESPONSE=$(wget -q -O- --header='Content-Type: application/json' --post-data='{"query":"query health { __schema { queryType { name } } }"}' "http://127.0.0.1:${POSTGRAPHILE_PORT:-5678}/graphql") && echo "$RESPONSE" | grep -q '"queryType"' && ! echo "$RESPONSE" | grep -q '"errors"' || exit 1
LABEL org.opencontainers.image.description="PostGraphile v5 GraphQL API server; schema, port, and default role via environment, optional JWT authentication and Turnstile verification, includes @graphile/postgis, Amber preset, and Grafast optimizations."
