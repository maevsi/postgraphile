import { Kind, parse } from 'graphql'
import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql'
import type { ProcessGraphQLRequestBodyEvent } from 'postgraphile/grafserv'

const IS_DEV = process.env['NODE_ENV'] !== 'production'
const TURNSTILE_BYPASS = Boolean(process.env['TURNSTILE_BYPASS'])
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

// Populated at schema-build time (see the `build` hook below) with the GraphQL field names of root Mutation fields whose underlying Postgres function carries the `@turnstileProtected` smart comment tag.
// This is the single source of truth for which mutations require Turnstile verification; the tag travels with the function itself, so a rename doesn't silently drop protection.
const turnstileProtectedFieldNames = new Set<string>()

// Recursively resolves the field names actually selected by a selection set, expanding fragment spreads and inline fragments.
// A security check based only on direct field selections could be bypassed by wrapping a protected field call in a fragment.
const collectFieldNames = (
  document: DocumentNode,
  selectionSet: SelectionSetNode,
  visitedFragmentNames = new Set<string>(),
): Set<string> => {
  const fieldNames = new Set<string>()
  const fragmentsByName = new Map(
     document.definitions
       .filter(
         (definition): definition is FragmentDefinitionNode =>
           definition.kind === Kind.FRAGMENT_DEFINITION,
       )
       .map((definition) => [definition.name.value, definition] as const),
   )

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD:
        fieldNames.add(selection.name.value)
        break
      case Kind.INLINE_FRAGMENT:
        for (const fieldName of collectFieldNames(
          document,
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
            document,
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

// Determines whether the operation that will actually execute (resolved the same way the GraphQL executor resolves it: via operationName, or the sole operation if unambiguous) is a mutation that invokes at least one turnstile-protected field.
// Anything ambiguous or unparseable is treated as requiring verification, so verification is still requested when unsure.
const requiresTurnstileVerification = (
  event: ProcessGraphQLRequestBodyEvent,
) => {
  const { operationName, query } = event.body

  if (typeof query !== 'string') return true

  let document: DocumentNode
  try {
    document = parse(query)
  } catch {
    return true
  }

  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  )

  const operation =
    typeof operationName === 'string'
      ? operations.find(
          (definition) => definition.name?.value === operationName,
        )
      : operations.length === 1
        ? operations[0]
        : undefined

  if (!operation) return true
  if (operation.operation !== 'mutation') return false

  const fieldNames = collectFieldNames(document, operation.selectionSet)
  return [...fieldNames].some((fieldName) =>
    turnstileProtectedFieldNames.has(fieldName),
  )
}

const TurnstilePlugin: GraphileConfig.Plugin = {
  name: 'TurnstilePlugin',
  version: '0.0.0',
  schema: {
    hooks: {
      // Root mutation fields backed by a custom function don't carry their pgResource in field scope (only computed columns and connection/list fields do), so instead of hooking each field, walk build.pgResources directly here: every resource tagged '@turnstileProtected' that's a mutation gets its final GraphQL field name computed via the same inflector graphile-build-pg itself uses to name that field, so this stays correct regardless of naming config.
      build(build) {
        turnstileProtectedFieldNames.clear()

        type MutationResource = Parameters<
          typeof build.inflection.customMutationField
        >[0]['resource']

        for (const resourceName in build.pgResources) {
          const resource = build.pgResources[resourceName] as MutationResource

          if (
            resource.isMutation &&
            resource.extensions?.tags?.['turnstileProtected']
          ) {
            turnstileProtectedFieldNames.add(
              build.inflection.customMutationField({ resource }),
            )
          }
        }

        return build
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

        const verification =
          (await result.json()) as TurnstileSiteverifyResponse

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
