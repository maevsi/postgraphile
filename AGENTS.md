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
- `src/presets/graphqlOperation.ts` resolves the operation a request will actually execute, shared by the presets above.

## JWT

- Algorithm: ES256
- Audience, issuer: postgraphile
- PostgreSQL composite type: `<POSTGRAPHILE_SCHEMA>.jwt`
- Role for a request: the token's `role` claim, falling back to `POSTGRAPHILE_DEFAULT_ROLE`; requests without a token run as the connection role
- Invalid tokens are rejected with HTTP 401 (set via `statusCode` on the thrown error, because grafserv derives the response status from the error object)

## Workflow

- Lint with `pnpm run lint`.

## General

- Code style
  - Sort any elements (imports, object properties, functions, ...), e.g. alphabetically, except when it doesn't make sense.
- Agents
  - After making changes to the codebase, ensure AGENTS.md is in sync with your knowledge of the project.
