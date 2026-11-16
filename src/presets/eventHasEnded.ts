import type { PgCondition } from 'postgraphile/@dataplan/pg'
import { addPgTableCondition } from 'postgraphile/utils'

import { getValidatedEnvironment } from '../environment.ts'

const { POSTGRAPHILE_SCHEMA } = getValidatedEnvironment([
  'POSTGRAPHILE_SCHEMA',
] as const)

// An event without an `end` ends at its `start` instant, as in iCalendar (RFC 5545).
// `now()` runs on the database clock, so a client clock that is off cannot change which events are returned.
const EventHasEndedPlugin = addPgTableCondition(
  { schemaName: POSTGRAPHILE_SCHEMA, tableName: 'event' },
  'hasEnded',
  ({ graphql: { GraphQLBoolean }, sql }) => ({
    apply(condition: PgCondition, value: boolean | null) {
      if (value === null) return

      const effectiveEnd = sql`coalesce(${condition.alias}.${sql.identifier('end')}, ${condition.alias}.${sql.identifier('start')})`

      condition.where(
        value ? sql`${effectiveEnd} < now()` : sql`${effectiveEnd} >= now()`,
      )
    },
    description:
      'Whether the event has ended, judged by its end, or by its start if it has no end, against the database clock.',
    type: GraphQLBoolean,
  }),
)

export const EventHasEndedPreset: GraphileConfig.Preset = {
  plugins: [EventHasEndedPlugin],
}
