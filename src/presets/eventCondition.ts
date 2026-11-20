import type { PgCondition } from 'postgraphile/@dataplan/pg'
import { sql } from 'postgraphile/pg-sql2'
import { addPgTableCondition } from 'postgraphile/utils'

import { getValidatedEnvironment } from '../environment.ts'

const { POSTGRAPHILE_SCHEMA } = getValidatedEnvironment([
  'POSTGRAPHILE_SCHEMA',
] as const)

const EVENT = { schemaName: POSTGRAPHILE_SCHEMA, tableName: 'event' }

// `effective_end` is the stored `coalesce("end", start)`, so an event without an `end` ends at its `start` instant, as in iCalendar (RFC 5545).
// Under row level security Postgres uses an index on a plain column but not one on the expression, so comparing the expression scans every event.
// `now()` runs on the database clock, so a client clock that is off cannot change which events are returned.
const EventHasEndedPlugin = addPgTableCondition(
  EVENT,
  'hasEnded',
  ({ graphql: { GraphQLBoolean } }) => ({
    apply(condition: PgCondition, value: boolean | null) {
      if (value === null) return

      const effectiveEnd = sql`${condition.alias}.${sql.identifier('effective_end')}`

      condition.where(
        value ? sql`${effectiveEnd} < now()` : sql`${effectiveEnd} >= now()`,
      )
    },
    description:
      'Whether the event has ended, judged by its end, or by its start if it has no end, against the database clock.',
    type: GraphQLBoolean,
  }),
)

// The invoker attends an event when one of their contacts has an accepted guest row for it.
// Guest and contact row level security apply, so the subquery sees only what the invoker may see, and the planner turns it into a semi join that starts at `contact(account_id)` and reaches `guest(contact_id)`, so the cost follows the invoker's own guests, not the event count.
const EventIsAttendingPlugin = addPgTableCondition(
  EVENT,
  'isAttending',
  ({ graphql: { GraphQLBoolean } }) => ({
    apply(condition: PgCondition, value: boolean | null) {
      if (value === null) return

      const attending = sql`exists (
        select 1
        from ${sql.identifier(POSTGRAPHILE_SCHEMA, 'guest')} g
        join ${sql.identifier(POSTGRAPHILE_SCHEMA, 'contact')} c on c.id = g.contact_id
        where g.event_id = ${condition.alias}.id
          and g.feedback = 'accepted'
          and c.account_id = ${sql.identifier(POSTGRAPHILE_SCHEMA, 'invoker_account_id')}()
      )`

      condition.where(value ? attending : sql`not ${attending}`)
    },
    description:
      'Whether the invoker attends the event, that is whether one of their contacts accepted a guest invitation to it. Combine with `hasEnded` to split upcoming from past events.',
    type: GraphQLBoolean,
  }),
)

// The invoker is invited to an event when they hold a claim to one of its guest rows, as after opening an invitation link, or when one of their contacts has a guest row for it, whatever the feedback.
// This mirrors `vibetype_private.events_invited()` in `maevsi/sqitch`, which the event row level security uses but which the private schema keeps out of GraphQL.
const EventIsInvitedPlugin = addPgTableCondition(
  EVENT,
  'isInvited',
  ({ graphql: { GraphQLBoolean } }) => ({
    apply(condition: PgCondition, value: boolean | null) {
      if (value === null) return

      const invited = sql`exists (
        select 1
        from ${sql.identifier(POSTGRAPHILE_SCHEMA, 'guest')} g
        where g.event_id = ${condition.alias}.id
          and (
            g.id = any (${sql.identifier(POSTGRAPHILE_SCHEMA, 'guest_claim_array')}())
            or exists (
              select 1
              from ${sql.identifier(POSTGRAPHILE_SCHEMA, 'contact')} c
              where c.id = g.contact_id
                and c.account_id = ${sql.identifier(POSTGRAPHILE_SCHEMA, 'invoker_account_id')}()
            )
          )
      )`

      condition.where(value ? invited : sql`not ${invited}`)
    },
    description:
      'Whether the invoker is invited to the event, that is whether they claimed one of its guest invitations or one of their contacts was invited to it, whatever the feedback. Combine with `hasEnded` to split upcoming from past invitations.',
    type: GraphQLBoolean,
  }),
)

// A condition instead of the `eventSearch` function, because PostGraphile omits condition and `orderBy` arguments on function connections, so the function cannot be scoped, while a condition composes with others such as `createdBy`.
// The ids come from `event_search_match`, which skips the relevance ranking `eventSearch` applies, so the order stays with the query's `orderBy`, which is acceptable for the events of one account.
// The outer query reads `event` as the invoker, so row level security still drops every event the invoker may not see, although the matcher itself is security definer.
// A null or blank value adds nothing, as an empty search box applies no filter.
const EventSearchPlugin = addPgTableCondition(
  EVENT,
  'search',
  ({ graphql: { GraphQLString } }) => ({
    apply(condition: PgCondition, value: string | null) {
      const trimmed = value?.trim()

      if (!trimmed) return

      condition.where(
        sql`${condition.alias}.id in (select event_id from ${sql.identifier(POSTGRAPHILE_SCHEMA, 'event_search_match')}(${sql.value(trimmed)}))`,
      )
    },
    description:
      'Events matching the search text by prefix on their name and description, or by similarity to their name. A blank text matches every event. Combine with other conditions such as `createdBy` to search within a subset.',
    type: GraphQLString,
  }),
)

const EventRangePlugins = (
  [
    [
      'endsBefore',
      'effective_end',
      sql`<`,
      'Events ending before this instant, exclusive, where an event without an end ends at its start.',
    ],
    [
      'endsFrom',
      'effective_end',
      sql`>=`,
      'Events ending at or after this instant, inclusive, where an event without an end ends at its start.',
    ],
    [
      'startsBefore',
      'start',
      sql`<`,
      'Events starting before this instant, exclusive.',
    ],
    [
      'startsFrom',
      'start',
      sql`>=`,
      'Events starting at or after this instant, inclusive.',
    ],
  ] as const
).map(([fieldName, column, operator, description]) =>
  addPgTableCondition(EVENT, fieldName, (build) => {
    const {
      dataplanPg: { sqlValueWithCodec, TYPES },
      graphql: { isInputType },
    } = build
    const type = build.getGraphQLTypeByPgCodec(TYPES.timestamptz, 'input')

    if (!isInputType(type)) {
      throw new Error(`Expected ${type} to be an input type`)
    }

    return {
      apply(condition: PgCondition, value: string | null) {
        if (value === null) return

        condition.where(
          sql`${condition.alias}.${sql.identifier(column)} ${operator} ${sqlValueWithCodec(value, TYPES.timestamptz)}`,
        )
      },
      description,
      type,
    }
  }),
)

export const EventConditionPreset: GraphileConfig.Preset = {
  plugins: [
    EventHasEndedPlugin,
    EventIsAttendingPlugin,
    EventIsInvitedPlugin,
    EventSearchPlugin,
    ...EventRangePlugins,
  ],
}
