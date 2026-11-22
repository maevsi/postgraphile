import { Kind, valueFromASTUntyped } from 'graphql'
import type {
  FieldNode,
  FragmentDefinitionNode,
  SelectionSetNode,
} from 'graphql'
import { SafeError } from 'postgraphile/grafast'

import { resolveOperation } from './graphqlOperation.ts'

const MODERATION_ERROR_CODE = 'VTMOD'
// Root mutation fields that publish user text, such as `createEvent`, `updateEventByRowId` or `updateAccount`.
const MODERATION_FIELD_NAME = /^(create|update)(Account|Event)(By\w+)?$/
// Input fields holding text that other people get to see.
const MODERATION_INPUT_FIELD_NAMES = new Set([
  'description',
  'displayName',
  'name',
])
// Free of charge (https://platform.openai.com/docs/pricing#moderation).
const MODERATION_MODEL = 'omni-moderation-latest'
const MODERATION_TIMEOUT_MS = 5000
const MODERATION_URL = 'https://api.openai.com/v1/moderations'
// dargstack fills a third-party secret nobody provided with this placeholder, which must count as unset, or every event mutation of a development stack would fail on OpenAI's rejection.
const OPENAI_API_KEY_PLACEHOLDER = 'UNSET THIRD PARTY SECRET'
const OPENAI_API_KEY =
  process.env['OPENAI_API_KEY'] === OPENAI_API_KEY_PLACEHOLDER
    ? undefined
    : process.env['OPENAI_API_KEY']

interface ModerationResponse {
  results: { flagged: boolean }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

// Returns the root fields an operation selects, expanding fragment spreads and inline fragments, as wrapping a mutation in a fragment must not skip the check.
const collectRootFields = (
  selectionSet: SelectionSetNode,
  fragmentsByName: ReadonlyMap<string, FragmentDefinitionNode>,
  visitedFragmentNames: ReadonlySet<string> = new Set(),
): FieldNode[] =>
  selectionSet.selections.flatMap((selection): FieldNode[] => {
    switch (selection.kind) {
      case Kind.FIELD:
        return [selection]
      case Kind.INLINE_FRAGMENT:
        return collectRootFields(
          selection.selectionSet,
          fragmentsByName,
          visitedFragmentNames,
        )
      case Kind.FRAGMENT_SPREAD: {
        const fragment = fragmentsByName.get(selection.name.value)

        if (!fragment || visitedFragmentNames.has(selection.name.value))
          return []

        return collectRootFields(
          fragment.selectionSet,
          fragmentsByName,
          new Set([...visitedFragmentNames, selection.name.value]),
        )
      }
    }
  })

const collectTexts = (value: unknown, texts: string[]) => {
  if (Array.isArray(value)) {
    for (const item of value) collectTexts(item, texts)
    return
  }

  if (!isRecord(value)) return

  for (const [key, child] of Object.entries(value)) {
    if (MODERATION_INPUT_FIELD_NAMES.has(key) && typeof child === 'string') {
      if (child.trim()) texts.push(child)
    } else {
      collectTexts(child, texts)
    }
  }
}

const moderate = async (texts: string[]) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODERATION_TIMEOUT_MS)

  // An unanswered check fails closed like Turnstile does, as letting text through unchecked would publish exactly what this preset exists to stop.
  try {
    const response = await fetch(MODERATION_URL, {
      body: JSON.stringify({ input: texts, model: MODERATION_MODEL }),
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    })

    if (!response.ok) {
      console.error('[moderation] OpenAI returned an error', {
        status: response.status,
      })
      throw new SafeError('Text moderation unavailable', { statusCode: 503 })
    }

    const moderation = (await response.json()) as ModerationResponse

    return moderation.results.some((result) => result.flagged)
  } catch (error) {
    if (error instanceof SafeError) throw error

    console.error('[moderation] Request failed', error)
    throw new SafeError(
      'Text moderation unavailable',
      { statusCode: 503 },
      { cause: error },
    )
  } finally {
    clearTimeout(timeout)
  }
}

const ModerationPlugin: GraphileConfig.Plugin = {
  name: 'ModerationPlugin',
  version: '0.0.0',
  grafserv: {
    middleware: {
      async processGraphQLRequestBody(next, event) {
        if (!OPENAI_API_KEY || event.request?.method !== 'POST') return next()

        const resolved = resolveOperation(event)

        if (resolved?.operation.operation !== 'mutation') return next()

        const fragmentsByName = new Map(
          resolved.document.definitions
            .filter(
              (definition): definition is FragmentDefinitionNode =>
                definition.kind === Kind.FRAGMENT_DEFINITION,
            )
            .map((definition) => [definition.name.value, definition] as const),
        )
        const variableValues = isRecord(event.body.variableValues)
          ? event.body.variableValues
          : {}
        const texts: string[] = []

        for (const field of collectRootFields(
          resolved.operation.selectionSet,
          fragmentsByName,
        )) {
          if (!MODERATION_FIELD_NAME.test(field.name.value)) continue

          for (const argument of field.arguments ?? []) {
            collectTexts(
              valueFromASTUntyped(argument.value, variableValues),
              texts,
            )
          }
        }

        if (texts.length && (await moderate(texts))) {
          // Only a `SafeError` keeps its status code and extensions on the way out, and the error code lets clients show their own message, as they do for the `VT` codes of the database.
          throw new SafeError('Text contains content that is not allowed', {
            errcode: MODERATION_ERROR_CODE,
            statusCode: 422,
          })
        }

        return next()
      },
    },
  },
}

export const ModerationPreset: GraphileConfig.Preset = {
  plugins: [ModerationPlugin],
}
