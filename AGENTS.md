---
applyTo: '**'
---
# Project Instructions
This project is a PostGraphile v5 server that converts PostgreSQL schemas into a GraphQL API. It defines one of many services of `vibetype`, an event community platform. The PostgreSQL schemas used by this service are applied as SQL migrations by the `sqitch` service.

## Files
- `src/graphile.config.ts` contains the main PostGraphile configuration.
- `src/graphile.ts` contains scripted logic.
- `src/environment.ts` contains type-safe environment variable utilities.

## JWT
- Algorithm: ES256
- Audience, issuer: postgraphile
- PostgreSQL composite type: `vibetype.jwt`

## Workflow
- Lint with `pnpm run lint`.

## General
- Code style
  - Sort any elements (imports, object properties, functions, ...), e.g. alphabetically, except when it doesn't make sense.
- Agents
  - After making changes to the codebase, ensure AGENTS.md is in sync with your knowledge of the project.
