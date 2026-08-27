import { Kind } from 'graphql'
import type { FragmentDefinitionNode, SelectionSetNode } from 'graphql'
import { SafeError } from 'postgraphile/grafast'
import type { ProcessGraphQLRequestBodyEvent } from 'postgraphile/grafserv'

import { resolveOperation } from './graphqlOperation.ts'

const IS_DEV = process.env['NODE_ENV'] !== 'production'
const TURNSTILE_BYPASS = process.env['TURNSTILE_BYPASS'] === 'true'
const TURNSTILE_SECRET_KEY = process.env['TURNSTILE_SECRET_KEY']
const TURNSTILE_SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'

if (!TURNSTILE_SECRET_KEY && !TURNSTILE_BYPASS) {
  throw new Error(
    'TURNSTILE_SECRET_KEY is required unless TURNSTILE_BYPASS is set to the exact string `true`.',
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

declare global {
  // Ambient module augmentation requires a `declare global { namespace ... }` block; there is no ES module equivalent for extending third-party types.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace GraphileBuild {
    interface Build {
      // Populated once per schema build (see the `init` and `GraphQLObjectType_fields_field` hooks below) with the GraphQL field names of root Mutation fields whose underlying Postgres resource (custom function or table) carries the `@turnstileProtected` smart comment tag.
      // This is the single source of truth for which mutations require Turnstile verification; the tag travels with the resource itself, so a rename doesn't silently drop protection.
      turnstileProtectedFieldNames: Set<string>
      // Resources carrying the tag that have not (yet) contributed a field name to the Set above.
      // Whatever is left in here when the schema is finalized is a tag that silently does nothing, which is worth shouting about.
      turnstilePendingTaggedResources: Set<
        GraphileBuild.Build['pgResources'][string]
      >
    }
  }
}

// `processGraphQLRequestBody` (below) runs ahead of grafast's schema-aware request pipeline, so it has no direct handle on the `build` object that produced the currently-serving schema; grafserv's `ProcessGraphQLRequestBodyEvent` only exposes `resolvedPreset`, `body`, `request` and `graphqlWsContext`, none of which reach back to `build`.
// We mirror the build-scoped Set here with a single atomic pointer swap once a schema build finishes (see the `finalize` hook below), so a concurrent request can never observe a half-populated Set the way the previous clear()-then-repopulate-in-place implementation could under watch-mode hot reload.
// This doesn't give each in-flight request a pin to the exact schema build it started against (grafserv's API doesn't expose that), so a request that started just before a hot reload could still observe the new build's Set; that's an inherent limitation of this plugin operating outside grafserv's schema-aware pipeline, not something fixable from here.
let currentTurnstileProtectedFieldNames = new Set<string>()

// grafserv installs its GraphQL handler as soon as the *preset* resolves, which is well before the first schema build finishes; with `retryOnInitFail` and a slow Postgres that gap is seconds to minutes after every restart.
// During that window the Set above is simply empty, which must not be mistaken for "nothing is protected", so we fail closed until a build has actually published its names.
let hasPublishedTurnstileProtectedFieldNames = false

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
  const resolved = resolveOperation(event)

  if (!resolved) return true
  // Only plain queries are exempt.
  // Whether an operation is a query is decided by the document's syntax alone, so this verdict holds even before a schema exists.
  if (resolved.operation.operation === 'query') return false

  // Everything below needs to know which fields are protected, so without a published Set there is nothing to decide against.
  if (!hasPublishedTurnstileProtectedFieldNames) return true

  const fragmentsByName = new Map(
    resolved.document.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((definition) => [definition.name.value, definition] as const),
  )

  const fieldNames = collectFieldNames(
    fragmentsByName,
    resolved.operation.selectionSet,
  )
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
      // `build` is frozen the moment its hooks have run, so the Sets the later hooks fill have to be created here.
      build(build) {
        build.turnstileProtectedFieldNames = new Set()
        build.turnstilePendingTaggedResources = new Set()

        return build
      },
      // Root mutation fields backed by a custom function don't carry their pgResource in field scope (only computed columns and connection/list fields do), so instead of hooking each field, walk build.pgResources directly here; the field name comes from the same inflector graphile-build-pg itself uses to name that field, so this stays correct regardless of naming config.
      // Whether such a function is exposed under `Mutation` at all is decided by `pgResourceMatches(resource, 'mutationField')`, not by `resource.isMutation` (which merely feeds that behavior's default, so a `@behavior mutationField` tag can expose a resource the flag says nothing about); `build.behavior` only exists once the `build` phase is over, hence `init` rather than `build`.
      init(_, build) {
        type MutationResource = Parameters<
          typeof build.inflection.customMutationField
        >[0]['resource']

        for (const resourceName in build.pgResources) {
          const resource = build.pgResources[resourceName]

          if (!resource?.extensions?.tags?.['turnstileProtected']) continue

          build.turnstilePendingTaggedResources.add(resource)

          if (
            resource.parameters &&
            build.behavior.pgResourceMatches(resource, 'mutationField')
          ) {
            build.turnstileProtectedFieldNames.add(
              build.inflection.customMutationField({
                resource: resource as MutationResource,
              }),
            )
            build.turnstilePendingTaggedResources.delete(resource)
          }
        }

        return _
      },
      // Table-backed CRUD mutations (createX/updateX/deleteX) always carry their originating `pgResource` in field scope, unlike the custom-function mutations handled above, so they're identified directly here instead of via inflector-based name guessing.
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
          build.turnstilePendingTaggedResources.delete(scope.pgFieldResource)
        }

        return field
      },
      finalize(schema, build) {
        // The hook above only runs for the Mutation type once graphql-js forces that type's lazy `fields` thunk, which it would otherwise not do until `validateSchema` runs downstream of this hook.
        // Forcing it here is what makes the Set genuinely complete at this point, rather than one that merely gains the table-backed CRUD names moments later through a shared reference.
        schema.getMutationType()?.getFields()

        for (const resource of build.turnstilePendingTaggedResources) {
          logger.error(
            `The '@turnstileProtected' tag on '${resource.name}' has no effect: the resource exposes no root mutation field. Only mutations can be protected.`,
          )
        }

        // Publish in one atomic pointer swap; see the comment on `currentTurnstileProtectedFieldNames` above.
        currentTurnstileProtectedFieldNames = new Set(
          build.turnstileProtectedFieldNames,
        )
        hasPublishedTurnstileProtectedFieldNames = true

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

        // Only a `SafeError` keeps its status code and message on the way out: grafserv replaces every other throw from this hook with a generic `400 Parsing failed`, which would leave the client unable to tell "re-run the challenge" from "my request was malformed".
        if (!token) {
          logger.error('No Turnstile token provided.')
          throw new SafeError('Turnstile token not provided', {
            statusCode: 422,
          })
        }

        const verificationTimeoutMs = 5000
        const controller = new AbortController()
        const timeout = setTimeout(
          () => controller.abort(),
          verificationTimeoutMs,
        )
        const requestFailure = (error: unknown) =>
          error instanceof Error &&
          (error.name === 'AbortError' || controller.signal.aborted)
            ? new SafeError(
                'Turnstile verification timed out',
                { statusCode: 504 },
                { cause: error },
              )
            : new SafeError(
                'Turnstile verification service unavailable',
                { statusCode: 503 },
                { cause: error },
              )
        let verification: TurnstileSiteverifyResponse

        // The timeout has to stay armed until the response body has been read, not just until its headers arrive: the body is read through the same abort signal, and clearing the timer early would let a stalled body pin this request, its socket and its pool slot open indefinitely.
        try {
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
            throw requestFailure(error)
          }

          if (!result.ok) {
            logger.error('Verification service returned an error', {
              status: result.status,
              statusText: result.statusText,
            })
            throw new SafeError('Turnstile verification service unavailable', {
              statusCode: 503,
            })
          }

          try {
            verification = (await result.json()) as TurnstileSiteverifyResponse
          } catch (error) {
            logger.error('Verification response could not be read', error)
            throw requestFailure(error)
          }
        } finally {
          clearTimeout(timeout)
        }

        logger.debug('Verification response', verification)

        if (!verification.success) {
          logger.error('Verification failed', {
            errorCodes: verification['error-codes'],
          })

          throw new SafeError('Turnstile verification failed', {
            statusCode: 401,
          })
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
