# syntax=docker/dockerfile:1

# <DEPENDENCIES>
FROM ghcr.io/maevsi/sqitch:11.0.0-beta.1
# </DEPENDENCIES>

########################
# Create base.

FROM oven/bun:1.3.9-alpine AS base

WORKDIR /srv/app/


########################
# Serve development.

FROM base AS development

ENV DEBUG=graphile-build-pg:sql
ENV GRAPHILE_ENV=development

RUN mkdir -p \
      /home/bun/.bun/install/cache \
      /srv/app/node_modules \
    && chown bun \
      /home/bun/.bun/install/cache \
      /srv/app/node_modules
VOLUME /home/bun/.bun/install/cache
VOLUME /srv/app
VOLUME /srv/app/node_modules

USER node
ENTRYPOINT ["/srv/app/docker-entrypoint.sh"]
CMD ["bun", "run", "--cwd", "src", "postgraphile", "--config", "./src/graphile.config.ts", "-n", "0.0.0.0"]
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q --spider http://127.0.0.1:5678/ || exit 1


########################
# Prepare environment.

FROM base AS prepare

COPY package.json bunfig.toml bun.lock graphile-postgis-0.2.0-1.tgz ./

RUN --mount=type=cache,id=bun-store,target=/home/bun/.bun/install/cache \
  bun install --frozen-lockfile

COPY src/graphile.config.ts ./


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

COPY --from=prepare /srv/app/src ./src
COPY --from=prepare /srv/app/docker-entrypoint.sh /srv/app/package.json ./
COPY --from=build /srv/app/node_modules ./node_modules
COPY --from=lint /srv/app/package.json /dev/null


########################
# Serve production.

FROM collect AS production

ENV NODE_ENV=production

USER node
ENTRYPOINT ["/srv/app/docker-entrypoint.sh"]
CMD ["bun", "run", "--cwd", "src", "postgraphile", "--config", "./src/graphile.config.ts", "-n", "0.0.0.0"]
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q --spider http://127.0.0.1:5678/ || exit 1
LABEL org.opencontainers.image.description="PostGraphile GraphQL API for the Vibetype platform; includes @graphile/postgis, Amber preset, Grafast optimizations, and JWT authentication."
