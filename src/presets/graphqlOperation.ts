import { getOperationAST, parse } from 'graphql'
import type { DocumentNode, OperationDefinitionNode } from 'graphql'
import type { ProcessGraphQLRequestBodyEvent } from 'postgraphile/grafserv'

export interface ResolvedOperation {
  document: DocumentNode
  operation: OperationDefinitionNode
}

const PARSE_CACHE_MAX_SIZE = 50
const PARSE_ERROR = Symbol('graphql-operation-parse-error')
const parseCache = new Map<string, DocumentNode | typeof PARSE_ERROR>()

// grafserv's own `parseAndValidate` (see `node_modules/grafserv/dist/middleware/graphql.js`) parses and caches the query too, but that happens downstream of the `processGraphQLRequestBody` middleware this module serves, so we can't share its cache.
// Memoizing here instead of per request means repeat visitors of the same query text don't pay for a parse at all, which also covers the case the previous per-event WeakMap existed for: several middleware resolving the operation of one request.
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

// Resolves the operation a request will execute, purely from the document's syntax.
// `getOperationAST` is what the GraphQL executor itself uses to pick the operation, so a caller can rely on this being the operation that actually runs rather than an approximation of it.
// Returns undefined for anything ambiguous or unparseable, so callers can fail safe.
export const resolveOperation = (
  event: ProcessGraphQLRequestBodyEvent,
): ResolvedOperation | undefined => {
  const { operationName, query } = event.body

  if (typeof query !== 'string') return undefined

  const document = parseWithCache(query)
  if (document === PARSE_ERROR) return undefined

  const operation = getOperationAST(
    document,
    typeof operationName === 'string' ? operationName : undefined,
  )

  return operation ? { document, operation } : undefined
}
