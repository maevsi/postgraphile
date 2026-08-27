import { Kind, getOperationAST, parse } from 'graphql'
import type {
  DocumentNode,
  FragmentDefinitionNode,
  SelectionSetNode,
} from 'graphql'
import type { ProcessGraphQLRequestBodyEvent } from 'postgraphile/grafserv'

const IS_DEV = process.env['NODE_ENV'] !== 'production'
const TURNSTILE_BYPASS = process.env['TURNSTILE_BYPASS'] === 'true'
const TURNSTILE_SECRET_KEY = process.env['TURNSTILE_SECRET_KEY']
const TURNSTILE_SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'

if (!TURNSTILE_SECRET_KEY && !TURNSTILE_BYPASS) {
  throw new Error(
    'TURNSTILE_SECRET_KEY is required unless TURNSTILE_BYPASS is set.',
  )
}

interface TurnstileSiteverifyResponse {
  success: boolean
  'error-codes'?: string[]
}

const logger = {
  debug: (message: string, data?: unknown) => {
    if (IS_DEV) {
      console.debug(`[turnstile] ${message}`, data)
    }
  },
  error: (message: string, data?: unknown) => {
    console.error(`[turnstile] ${message}`, data)
  },
}
const setStatusCode = (
  event: ProcessGraphQLRequestBodyEvent,
  statusCode: number,
) => {
  const requestContext = event.request?.requestContext
  if (requestContext?.node?.res) {
    requestContext.node.res.statusCode = statusCode
  }
}

declare global {
  // Ambient module augmentation requires a `declare global { namespace ... }`
  // block; there is no ES module equivalent for extending third-party types.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace GraphileBuild {
    interface Build {
      // Populated once per schema build (see the `build` and
      // `GraphQLObjectType_fields_field` hooks below) with the GraphQL field
      // names of root Mutation fields whose underlying Postgres resource
      // (custom function or table) carries the `@turnstileProtected` smart
      // comment tag.
      // This is the single source of truth for which mutations require
      // Turnstile verification; the tag travels with the resource itself,
      // so a rename doesn't silently drop protection.
      turnstileProtectedFieldNames: Set<string>
    }
  }
}

// `processGraphQLRequestBody` (below) runs ahead of grafast's schema-aware
// request pipeline, so it has no direct handle on the `build` object that
// produced the currently-serving schema; grafserv's
// `ProcessGraphQLRequestBodyEvent` only exposes `resolvedPreset`, `body`,
// `request` and `graphqlWsContext`, none of which reach back to `build`.
// We mirror the build-scoped Set here with a single atomic pointer swap once
// a schema build finishes (see the `finalize` hook below), so a concurrent
// request can never observe a half-populated Set the way the previous
// clear()-then-repopulate-in-place implementation could under watch-mode
// hot reload. This doesn't give each in-flight request a pin to the exact
// schema build it started against (grafserv's API doesn't expose that), so
// a request that started just before a hot reload could still observe the
// new build's Set; that's an inherent limitation of this plugin operating
// outside grafserv's schema-aware pipeline, not something fixable from here.
let currentTurnstileProtectedFieldNames = new Set<string>()

const PARSE_CACHE_MAX_SIZE = 50
const PARSE_ERROR = Symbol('turnstile-parse-error')
const parseCache = new Map<string, DocumentNode | typeof PARSE_ERROR>()

// grafserv's own `parseAndValidate` (see
// `node_modules/grafserv/dist/middleware/graphql.js`) parses and caches the
// query too, but that happens downstream of this hook, so we can't share
// its cache; memoize our own parse here instead of re-parsing the same
// query text on every request.
const parseWithCache = (query: string): DocumentNode | typeof PARSE_ERROR => {
  const cached = parseCache.get(query)
  if (cached !== undefined) {
    // Refresh recency so frequently-seen queries survive eviction.
    parseCache.delete(query)
    parseCache.set(query, cached)
    return cached
  }

  let parsed: DocumentNode | typeof PARSE_ERROR
  try {
    parsed = parse(query)
  } catch {
    parsed = PARSE_ERROR
  }

  parseCache.set(query, parsed)
  if (parseCache.size > PARSE_CACHE_MAX_SIZE) {
    const oldestKey = parseCache.keys().next().value
    if (oldestKey !== undefined) parseCache.delete(oldestKey)
  }

  return parsed
}

// Recursively resolves the field names actually selected by a selection set, expanding fragment spreads and inline fragments.
// A security check based only on direct field selections could be bypassed by wrapping a protected field call in a fragment.
const collectFieldNames = (
  fragmentsByName: ReadonlyMap<string, FragmentDefinitionNode>,
  selectionSet: SelectionSetNode,
  visitedFragmentNames = new Set<string>(),
): Set<string> => {
  const fieldNames = new Set<string>()

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        fieldNames.add(selection.name.value)
        break
      case Kind.INLINE_FRAGMENT:
        for (const fieldName of collectFieldNames(
          fragmentsByName,
          selection.selectionSet,
          visitedFragmentNames,
        )) {
          fieldNames.add(fieldName)
        }
        break
      case Kind.FRAGMENT_SPREAD: {
        const fragmentName = selection.name.value
        if (visitedFragmentNames.has(fragmentName)) break
        visitedFragmentNames.add(fragmentName)

        const fragment = fragmentsByName.get(fragmentName)
        if (fragment) {
          for (const fieldName of collectFieldNames(
            fragmentsByName,
            fragment.selectionSet,
            visitedFragmentNames,
          )) {
            fieldNames.add(fieldName)
          }
        }
        break
      }
    }
  }

  return fieldNames
}

// Determines whether the operation that will actually execute (resolved the same way the GraphQL executor resolves it: via operationName, or the sole operation if unambiguous) is a mutation or subscription that invokes at least one turnstile-protected field.
// Anything ambiguous or unparseable is treated as requiring verification, so verification is still requested when unsure.
const requiresTurnstileVerification = (
  event: ProcessGraphQLRequestBodyEvent,
) => {
  const { operationName, query } = event.body

  if (typeof query !== 'string') return true

  const document = parseWithCache(query)
  if (document === PARSE_ERROR) return true

  const operation = getOperationAST(
    document,
    typeof operationName === 'string' ? operationName : undefined,
  )

  if (!operation) return true
  // Only plain queries are exempt; both mutations and subscriptions can
  // invoke protected fields and must be checked.
  if (operation.operation === 'query') return false

  const fragmentsByName = new Map(
    document.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((definition) => [definition.name.value, definition] as const),
  )

  const fieldNames = collectFieldNames(fragmentsByName, operation.selectionSet)
  for (const fieldName of fieldNames) {
    if (currentTurnstileProtectedFieldNames.has(fieldName)) return true
  }

  return false
}

const TurnstilePlugin: GraphileConfig.Plugin = {
  name: 'TurnstilePlugin',
  version: '0.0.0',
  schema: {
    hooks: {
      // Root mutation fields backed by a custom function don't carry their pgResource in field scope (only computed columns and connection/list fields do), so instead of hooking each field, walk build.pgResources directly here: every resource tagged '@turnstileProtected' that's a mutation gets its final GraphQL field name computed via the same inflector graphile-build-pg itself uses to name that field, so this stays correct regardless of naming config.
      build(build) {
        const protectedFieldNames = new Set<string>()

        type MutationResource = Parameters<
          typeof build.inflection.customMutationField
        >[0]['resource']

        for (const resourceName in build.pgResources) {
          const resource = build.pgResources[resourceName] as MutationResource

          if (
            resource.isMutation &&
            resource.extensions?.tags?.['turnstileProtected']
          ) {
            protectedFieldNames.add(
              build.inflection.customMutationField({ resource }),
            )
          }
        }

        build.turnstileProtectedFieldNames = protectedFieldNames

        return build
      },
      // Table-backed CRUD mutations (createX/updateX/deleteX) always carry
      // their originating `pgResource` in field scope, unlike the
      // custom-function mutations handled above, so they're identified
      // directly here instead of via inflector-based name guessing.
      GraphQLObjectType_fields_field(field, build, context) {
        const { scope } = context

        if (
          scope.isRootMutation &&
          (scope.isPgCreateMutation ||
            scope.isPgUpdateMutation ||
            scope.isPgDeleteMutation) &&
          scope.pgFieldResource?.extensions?.tags?.['turnstileProtected']
        ) {
          build.turnstileProtectedFieldNames.add(scope.fieldName)
        }

        return field
      },
      finalize(schema, build) {
        // Publish the fully-populated Set in one atomic pointer swap; see
        // the comment on `currentTurnstileProtectedFieldNames` above.
        currentTurnstileProtectedFieldNames = build.turnstileProtectedFieldNames

        return schema
      },
    },
  },
  grafserv: {
    middleware: {
      async processGraphQLRequestBody(next, event) {
        logger.debug('Request method', event.request?.method)
        logger.debug('Request body', event.body)
        logger.debug(
          'Request headers',
          event.request?.requestContext.node?.req.headers,
        )

        if (event.request?.method !== 'POST') {
          logger.debug('Skipping verification for non-POST request.')
          return next()
        }

        if (TURNSTILE_BYPASS) {
          logger.debug('Turnstile bypass enabled, skipping verification.')
          return next()
        }

        if (!requiresTurnstileVerification(event)) {
          logger.debug(
            'Skipping verification; no protected operation is invoked.',
          )
          return next()
        }

        const token = event.request.getHeader('x-turnstile-key')
        logger.debug('Received Turnstile token', { present: Boolean(token) })

        if (!token) {
          logger.error('No Turnstile token provided.')
          setStatusCode(event, 422)
          throw new Error('Turnstile token not provided')
        }

        const verificationTimeoutMs = 5000
        const controller = new AbortController()
        const timeout = setTimeout(
          () => controller.abort(),
          verificationTimeoutMs,
        )
        let result: Response

        try {
          result = await fetch(TURNSTILE_SITEVERIFY_URL, {
            body: new URLSearchParams({
              response: token,
              secret: TURNSTILE_SECRET_KEY ?? '',
            }),
            method: 'POST',
            signal: controller.signal,
          })
        } catch (error) {
          logger.error('Verification request failed', error)

          if (
            error instanceof Error &&
            (error.name === 'AbortError' || controller.signal.aborted)
          ) {
            setStatusCode(event, 504)
            throw new Error('Turnstile verification timed out', {
              cause: error,
            })
          }

          setStatusCode(event, 503)
          throw new Error('Turnstile verification service unavailable', {
            cause: error,
          })
        } finally {
          clearTimeout(timeout)
        }

        if (!result.ok) {
          logger.error('Verification service returned an error', {
            status: result.status,
            statusText: result.statusText,
          })
          setStatusCode(event, 503)
          throw new Error('Turnstile verification service unavailable')
        }

        let verification: TurnstileSiteverifyResponse

        try {
          verification = (await result.json()) as TurnstileSiteverifyResponse
        } catch (error) {
          logger.error('Verification response could not be parsed', error)
          setStatusCode(event, 503)
          throw new Error('Turnstile verification service unavailable', {
            cause: error,
          })
        }

        if (IS_DEV) {
          logger.debug('Verification response', verification)
        }

        if (!verification.success) {
          logger.error('Verification failed', {
            errorCodes: verification['error-codes'],
          })
          setStatusCode(event, 401)

          throw new Error('Turnstile verification failed')
        }

        logger.debug('Verification succeeded')
        return next()
      },
    },
  },
}

export const TurnstilePreset: GraphileConfig.Preset = {
  plugins: [TurnstilePlugin],
}
