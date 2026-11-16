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
  plugins: [EventHasEndedPlugin, ...EventRangePlugins],
}
