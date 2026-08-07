---
applyTo: '**'
---
# Project Instructions
This project is a PostGraphile v5 server that converts PostgreSQL schemas into a GraphQL API. It defines one of many services of `vibetype`, an event community platform. The PostgreSQL schemas used by this service are applied as SQL migrations by the `sqitch` service.

## Files
- `src/graphile.config.ts` contains the main PostGraphile configuration.
- `src/graphile.ts` contains scripted logic.
- `src/environment.ts` contains type-safe environment variable utilities.
- `src/presets/` contains the presets that `src/graphile.config.ts` composes.

## JWT
- Algorithm: ES256
- Audience, issuer: postgraphile
- PostgreSQL composite type: `vibetype.jwt`

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
