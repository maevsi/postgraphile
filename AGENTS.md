---
applyTo: '**'
---

# Project Instructions

This project is a PostGraphile v5 server that converts a PostgreSQL schema into a GraphQL API. It defines one of many services of `vibetype`, an event community platform, and can be used by other platforms as well. The PostgreSQL schemas used by this service are applied as SQL migrations by the `sqitch` service.

## Environment variables

- Required: `POSTGRAPHILE_CONNECTION`, `POSTGRAPHILE_OWNER_CONNECTION`, `POSTGRAPHILE_SCHEMA`
- Optional: `POSTGRAPHILE_PORT` (default 5678), `POSTGRAPHILE_DEFAULT_ROLE`, `SENTRY_DSN`
- JWT authentication is enabled when both `POSTGRAPHILE_JWT_PUBLIC_KEY` and `POSTGRAPHILE_JWT_SECRET_KEY` are set; one alone fails startup
- The Turnstile preset is active when `TURNSTILE_SECRET_KEY` is set or `TURNSTILE_BYPASS` is the exact string `true`; it verifies mutations on resources tagged `@turnstileProtected` against Cloudflare; `TURNSTILE_BYPASS` skips verification
- Secrets can be delivered as files in `/run/environment-variables` (loaded by `docker-entrypoint.sh`); `POSTGRAPHILE_PORT` must be a container-level environment variable because the image `HEALTHCHECK` does not see the entrypoint's exports

## Files

- `src/graphile.config.ts` contains the main PostGraphile configuration.
- `src/graphile.ts` contains scripted logic (JWT verification, default role).
- `src/environment.ts` contains type-safe environment variable utilities.
- `src/instrument.ts` contains the Sentry initialization.
- `src/presets/turnstile.ts` contains the Turnstile verification preset.
- `src/presets/passwordStrength.ts` contains the zxcvbn password strength preset.
- `src/presets/connection-filter.ts` contains the connection filter preset, see Filtering.
- `src/presets/graphqlOperation.ts` resolves the operation a request will actually execute, shared by the presets above.

## JWT

- Algorithm: ES256
- Audience, issuer: postgraphile
- PostgreSQL composite type: `<POSTGRAPHILE_SCHEMA>.jwt`
- Role for a request: the token's `role` claim, falling back to `POSTGRAPHILE_DEFAULT_ROLE`; requests without a token run as the connection role
- Invalid tokens are rejected with HTTP 401 (set via `statusCode` on the thrown error, because grafserv derives the response status from the error object)

## Filtering

- `postgraphile-plugin-connection-filter` adds a `filter` argument to connections, and everything that narrows it down lives in `src/presets/connection-filter.ts`
- Filtering is opt-in: a table only becomes filterable once a `maevsi/sqitch` migration tags it with a `@behavior +filter` smart comment
  - The plugin grants an unscoped `filter` behavior to every codec and resource, so making it opt-in means revoking that behavior again
  - That revocation cannot go into `schema.defaultBehavior`, because PostGraphile's built-in `condition` argument is gated on the same behavior name under a field scope such as `query:resource:connection:filter`, and an unscoped `-filter` matches those scoped checks too, which would strip every `condition` argument from the schema
  - `ConnectionFilterOptInPlugin` revokes it per entity instead and re-grants the scoped variants through `+*:filter`, leaving `condition` untouched
- Which columns an opted-in table exposes follows PostGraphile's own `filterBy` behavior, which covers indexed columns by default plus whatever a `@behavior +attribute:filterBy` smart comment adds
- `connectionFilterAllowedFieldTypes` and `connectionFilterAllowedOperators` narrow that down further, currently to comparisons on datetime columns
- The plugin's `connectionFilterComputedColumns`, `connectionFilterLogicalOperators` and `connectionFilterRelations` schema options are no-ops as of v3.0.3 because nothing in the plugin reads them, so the plugins they are meant to gate are dropped through `disablePlugins` instead

## Workflow

- Lint with `pnpm run lint`.
- Smoke-test a built image with `SMOKE_TEST_IMAGE=<image> .github/smoke-test.sh`, which boots it against a fixture schema and asserts the shape of the generated GraphQL schema.

## General

- Code style
  - Sort any elements (imports, object properties, functions, ...), e.g. alphabetically, except when it doesn't make sense.
- Agents
  - After making changes to the codebase, ensure AGENTS.md is in sync with your knowledge of the project.
