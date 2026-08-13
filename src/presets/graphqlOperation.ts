import { Kind, parse } from 'graphql'
import type { DocumentNode, OperationDefinitionNode } from 'graphql'
import type { ProcessGraphQLRequestBodyEvent } from 'postgraphile/grafserv'

export interface ResolvedOperation {
  document: DocumentNode
  operation: OperationDefinitionNode
}

// Resolves the operation a request will execute, purely from the document's syntax.
// Returns undefined for anything ambiguous or unparseable, so callers can fail safe.
export const resolveOperation = (
  event: ProcessGraphQLRequestBodyEvent,
): ResolvedOperation | undefined => {
  const { operationName, query } = event.body

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
}
