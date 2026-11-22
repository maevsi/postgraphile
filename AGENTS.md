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
- The moderation preset is active when `OPENAI_API_KEY` is set; it sends the `name`, `description` and `displayName` input values of `create` and `update` mutations on accounts and events to OpenAI's moderation model before they run
  - Flagged text fails with HTTP 422 and the extension `errcode: VTMOD`, which clients map to their own message like the database's `VT` codes
  - An unreachable or failing OpenAI fails the mutation with HTTP 503, as Turnstile does, so text never gets published unchecked
- Secrets can be delivered as files in `/run/environment-variables` (loaded by `docker-entrypoint.sh`); `POSTGRAPHILE_PORT` must be a container-level environment variable because the image `HEALTHCHECK` does not see the entrypoint's exports

## Files

- `src/graphile.config.ts` contains the main PostGraphile configuration.
- `src/graphile.ts` contains scripted logic (JWT verification, default role).
- `src/environment.ts` contains type-safe environment variable utilities.
- `src/instrument.ts` contains the Sentry initialization.
- `src/presets/turnstile.ts` contains the Turnstile verification preset.
- `src/presets/moderation.ts` contains the text moderation preset.
- `src/presets/passwordStrength.ts` contains the zxcvbn password strength preset.
- `src/presets/graphqlOperation.ts` resolves the operation a request will actually execute, shared by the presets above.
- `src/presets/eventCondition.ts` contains the preset adding the `hasEnded`, `isAttending`, `isInvited`, `search` and time range conditions to events.

## JWT

- Algorithm: ES256
- Audience, issuer: postgraphile
- PostgreSQL composite type: `<POSTGRAPHILE_SCHEMA>.jwt`
- Role for a request: the token's `role` claim, falling back to `POSTGRAPHILE_DEFAULT_ROLE`; requests without a token run as the connection role
- Invalid tokens are rejected with HTTP 401 (set via `statusCode` on the thrown error, because grafserv derives the response status from the error object)

## Event condition

- The conditions compare `effective_end`, a stored generated column `COALESCE("end", start)` that `maevsi/sqitch` provides and hides from the GraphQL schema with `@behavior -*`, so an event without an end ends at its start, as in iCalendar (RFC 5545)
  - Under row level security Postgres uses an index on that plain column but not one on the expression
- `EventCondition.hasEnded` selects events by `effective_end < now()` (`true`) or `>= now()` (`false`)
  - `now()` is the database clock, so clients send no timestamp
- `EventCondition.startsFrom` and `startsBefore` select events by `start >= value` and `start < value`
- `EventCondition.endsFrom` and `endsBefore` select events by `effective_end >= value` and `effective_end < value`
- `EventCondition.isAttending` selects events for which one of the invoker's contacts has a guest row with feedback `accepted` (`true`), or none (`false`)
  - It is a correlated `exists` over `guest` and `contact` on `contact.account_id = invoker_account_id()`, run under row level security, so anonymous requests match no event for `true`
  - Combined with `hasEnded` and `orderBy` it serves a "my events" page, upcoming (`hasEnded: false`, `START_ASC`) and past (`hasEnded: true`, `START_DESC`), paged through the connection arguments
- `EventCondition.isInvited` selects events for which the invoker claimed a guest row, or one of their contacts has a guest row with any feedback (`true`), or neither (`false`)
  - It mirrors `vibetype_private.events_invited()` from `maevsi/sqitch`, which the event row level security uses but GraphQL cannot reach, so a change to who counts as invited belongs in both
  - Combined with `hasEnded` and `orderBy` it serves an invitations page the same way `isAttending` serves "my events"
- `EventCondition.search` selects events whose id `vibetype.event_search_match(query)` returns, the matcher behind `eventSearch`, for the trimmed text; null or blank adds nothing
  - It exists because condition and `orderBy` arguments are omitted on function connections, so `eventSearch` cannot be scoped, while `allEvents(condition: {createdBy: $id, search: $query})` can
  - Ordering stays with `orderBy`, with no relevance ranking, and event row level security still applies because the outer query reads `event` as the invoker
- The ranges are half-open, so `startsBefore` and `endsFrom` together select every event overlapping a window, and `startsFrom` and `startsBefore` every event starting in it
- A null or omitted condition adds nothing
- They apply to the table `event` in `POSTGRAPHILE_SCHEMA`; a schema without that table logs `WARNING: failed to add condition '<name>'` for each of them on every schema build
- An `event` table without `effective_end` still builds the schema, but every query using one of these conditions fails

## Workflow

- Lint with `pnpm run lint`.
- A change is breaking when it removes or changes something a client relies on, or when it only works with something new from another service of the stack, for example a column that only a newer `sqitch` provides
  - Breaking changes get `!` in the title and target a `beta` branch, where they wait until the stack releases the majors of its services together; the rules are in [`stack`'s release bundle document](https://github.com/maevsi/stack/blob/main/docs/release-bundle.md)

## General

- Code style
  - Sort any elements (imports, object properties, functions, ...), e.g. alphabetically, except when it doesn't make sense.
- Agents
  - After making changes to the codebase, ensure AGENTS.md is in sync with your knowledge of the project.
