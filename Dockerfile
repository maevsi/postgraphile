# syntax=docker/dockerfile:1

########################
# Create base.

FROM node:24.13.1-alpine AS base

# The `CI` environment variable must be set for pnpm to run in headless mode
ENV CI=true

WORKDIR /srv/app/

RUN corepack enable


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
ENTRYPOINT ["/srv/app/docker-entrypoint.sh"]
CMD ["pnpm", "exec", "postgraphile", "--config", "./src/graphile.config.ts", "-n", "0.0.0.0"]
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q --spider http://127.0.0.1:5678/ || exit 1


########################
# Prepare environment.

FROM base AS prepare

COPY ./pnpm-lock.yaml ./package.json ./graphile-postgis-v0.2.0.tgz ./

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

COPY --from=prepare /srv/app/docker-entrypoint.sh /srv/app/package.json ./
COPY --from=prepare /srv/app/src ./src
COPY --from=build /srv/app/node_modules ./node_modules
COPY --from=lint /srv/app/package.json /dev/null


########################
# Serve production.

FROM collect AS production

ENV NODE_ENV=production

USER node
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["pnpm", "exec", "postgraphile", "--config", "./src/graphile.config.ts", "-n", "0.0.0.0"]
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q --spider http://127.0.0.1:5678/ || exit 1
LABEL org.opencontainers.image.description="Instant high-performance GraphQL API for your PostgreSQL database https://github.com/graphile/postgraphile"
