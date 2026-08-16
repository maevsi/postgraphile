import { Kind, parse } from 'graphql'
import type { DocumentNode, OperationDefinitionNode } from 'graphql'
import type { ProcessGraphQLRequestBodyEvent } from 'postgraphile/grafserv'

export interface ResolvedOperation {
  document: DocumentNode
  operation: OperationDefinitionNode
}

// Multiple middleware (turnstile, passwordStrength) resolve the operation for the same
// request; caching by event avoids parsing the query more than once per request.
const resolutionCache = new WeakMap<
  ProcessGraphQLRequestBodyEvent,
  ResolvedOperation | undefined
>()

// Resolves the operation a request will execute, purely from the document's syntax.
// Returns undefined for anything ambiguous or unparseable, so callers can fail safe.
export const resolveOperation = (
  event: ProcessGraphQLRequestBodyEvent,
): ResolvedOperation | undefined => {
  if (resolutionCache.has(event)) return resolutionCache.get(event)

  const { operationName, query } = event.body

  const resolved = ((): ResolvedOperation | undefined => {
    if (typeof query !== 'string') return undefined

    let document: DocumentNode
    try {
      document = parse(query)
    } catch {
      return undefined
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

    return operation && { document, operation }
  })()

  resolutionCache.set(event, resolved)
  return resolved
}

export const setStatusCode = (
  event: ProcessGraphQLRequestBodyEvent,
  statusCode: number,
) => {
  const requestContext = event.request?.requestContext
  if (requestContext?.node?.res) {
    requestContext.node.res.statusCode = statusCode
  }
}
