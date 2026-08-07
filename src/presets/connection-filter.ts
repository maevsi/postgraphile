import { PostGraphileConnectionFilterPreset } from 'postgraphile-plugin-connection-filter'

const FILTER_ARGUMENT_OFF = '-filter' satisfies GraphileBuild.BehaviorString
// `GraphileBuild.BehaviorString` only covers unscoped behavior names, so the scoped wildcard needs
// a cast.
const CONDITION_ARGUMENT_ON = '+*:filter' as GraphileBuild.BehaviorString

/**
 * `postgraphile-plugin-connection-filter` grants the unscoped `filter` behavior to every codec and
 * resource, and that behavior is what gates the `filter` argument it adds to connections.
 * Revoking it again is what makes filtering opt-in, so a table is only filterable once a
 * `maevsi/sqitch` migration tags it with a `@behavior +filter` smart comment.
 *
 * This cannot be expressed through `schema.defaultBehavior`.
 * PostGraphile's built-in `condition` argument is gated on the same behavior name under a field
 * scope such as `query:resource:connection:filter`, and an unscoped `-filter` matches those scoped
 * checks as well, so a global `-filter` would strip every `condition` argument from the schema.
 * Re-granting `+*:filter` covers the scoped checks again, and doing so per entity rather than
 * globally keeps functions returning `setof` without a `condition` argument, which is where
 * PostGraphile withholds `filter` itself.
 */
const ConnectionFilterOptInPlugin: GraphileConfig.Plugin = {
  name: 'ConnectionFilterOptInPlugin',
  version: '0.0.0',
  schema: {
    entityBehavior: {
      pgCodec: {
        inferred: (behavior) => [
          behavior,
          FILTER_ARGUMENT_OFF,
          CONDITION_ARGUMENT_ON,
        ],
      },
      pgResource: {
        inferred: (behavior, resource) =>
          resource.parameters
            ? [behavior, FILTER_ARGUMENT_OFF]
            : [behavior, FILTER_ARGUMENT_OFF, CONDITION_ARGUMENT_ON],
      },
    },
  },
}

export const ConnectionFilterPreset: GraphileConfig.Preset = {
  // The `connectionFilterComputedColumns`, `connectionFilterLogicalOperators` and
  // `connectionFilterRelations` schema options are no-ops as of v3.0.3: none of the plugins read
  // them, so the plugins they are meant to gate get loaded either way.
  // Dropping those plugins by name is the only way to remove the surface they add: a function call
  // per row through computed columns, unbounded nesting through `and`/`or`/`not`, and correlated
  // `EXISTS` subqueries through relations.
  disablePlugins: [
    'PgConnectionArgFilterBackwardRelationsPlugin',
    'PgConnectionArgFilterComputedAttributesPlugin',
    'PgConnectionArgFilterForwardRelationsPlugin',
    'PgConnectionArgFilterLogicalOperatorsPlugin',
  ],
  extends: [PostGraphileConnectionFilterPreset],
  plugins: [ConnectionFilterOptInPlugin],
  schema: {
    // Filtering stays limited to comparisons on datetime columns, which is all the platform needs
    // and keeps the plugin from exposing pattern matching and array containment on everything.
    connectionFilterAllowedFieldTypes: ['Datetime'],
    connectionFilterAllowedOperators: [
      'equalTo',
      'greaterThan',
      'greaterThanOrEqualTo',
      'isNull',
      'lessThan',
      'lessThanOrEqualTo',
      'notEqualTo',
    ],
    connectionFilterArrays: false,
    connectionFilterSetofFunctions: false,
  },
}
