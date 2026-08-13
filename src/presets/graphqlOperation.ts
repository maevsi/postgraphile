import { Kind, parse } from 'graphql'
import type { OperationDefinitionNode } from 'graphql'
import type { ProcessGraphQLRequestBodyEvent } from 'postgraphile/grafserv'

// Resolves the operation a request will execute, purely from the document's syntax.
// Returns undefined for anything ambiguous or unparseable, so callers can fail safe.
export const resolveOperation = (
  event: ProcessGraphQLRequestBodyEvent,
): OperationDefinitionNode | undefined => {
  const { operationName, query } = event.body

  if (typeof query !== 'string') return undefined

  let operations: OperationDefinitionNode[]
  try {
    operations = parse(query).definitions.filter(
      (definition): definition is OperationDefinitionNode =>
        definition.kind === Kind.OPERATION_DEFINITION,
    )
  } catch {
    return undefined
  }

  return typeof operationName === 'string'
    ? operations.find((definition) => definition.name?.value === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined
}
