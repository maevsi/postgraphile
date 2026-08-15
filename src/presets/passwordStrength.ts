import ZxcvbnCore from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnDePackage from '@zxcvbn-ts/language-de'
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en'
import { Kind } from 'graphql'
import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  SelectionSetNode,
} from 'graphql'

import { resolveOperation } from './graphqlOperation.ts'

const { ZxcvbnFactory } = ZxcvbnCore

// This configuration must match vibetype's app/utils/passwordStrength.ts; see the shared
// contract at stack:docs/password-strength.md.
// TODO: consider extracting this into a shared @maevsi package instead of duplicating it.

// Mutations that set a new password, and the `input` field carrying it. The minimum length
// itself is enforced identically (>= 8 characters) by every underlying sqitch function, so
// this plugin only needs to cover the zxcvbn score.
const PASSWORD_MUTATIONS = [
  { fieldName: 'accountPasswordChange', passwordFieldName: 'passwordNew' },
  { fieldName: 'accountPasswordReset', passwordFieldName: 'password' },
  { fieldName: 'accountRegistration', passwordFieldName: 'password' },
]
// Score 3 ("safely unguessable") is zxcvbn's own threshold for resisting an
// offline, slow-hash attack; see https://github.com/zxcvbn-ts/zxcvbn
const PASSWORD_SCORE_MINIMUM = 3

const zxcvbn = new ZxcvbnFactory({
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnDePackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  translations: zxcvbnEnPackage.translations,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const getFragmentDefinitions = (
  document: DocumentNode,
): Map<string, FragmentDefinitionNode> =>
  new Map(
    document.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode =>
          definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((fragment) => [fragment.name.value, fragment]),
  )

// Recursively walks the selection set, resolving fragment spreads and inline
// fragments, and returns every field matching `fieldName` regardless of how
// deeply it's nested or how many times it's aliased. `ancestorFragments`
// guards against cyclic fragment references without skipping legitimate
// re-use of the same fragment in sibling branches.
const findFields = (
  selectionSet: SelectionSetNode,
  fieldName: string,
  fragments: Map<string, FragmentDefinitionNode>,
  ancestorFragments: ReadonlySet<string>,
): FieldNode[] =>
  selectionSet.selections.flatMap((selection) => {
    if (selection.kind === Kind.FIELD) {
      const nested = selection.selectionSet
        ? findFields(
            selection.selectionSet,
            fieldName,
            fragments,
            ancestorFragments,
          )
        : []

      return selection.name.value === fieldName
        ? [selection, ...nested]
        : nested
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      return findFields(
        selection.selectionSet,
        fieldName,
        fragments,
        ancestorFragments,
      )
    }

    // Kind.FRAGMENT_SPREAD
    const fragmentName = selection.name.value
    if (ancestorFragments.has(fragmentName)) return []

    const fragment = fragments.get(fragmentName)
    if (!fragment) return []

    return findFields(
      fragment.selectionSet,
      fieldName,
      fragments,
      new Set([...ancestorFragments, fragmentName]),
    )
  })

const extractPassword = (
  field: FieldNode,
  passwordFieldName: string,
  variableValues: Record<string, unknown>,
): string | undefined => {
  const inputArgument = field.arguments?.find(
    (argument) => argument.name.value === 'input',
  )
  if (!inputArgument) return undefined

  if (inputArgument.value.kind === Kind.VARIABLE) {
    const input = variableValues[inputArgument.value.name.value]
    return isRecord(input) && typeof input[passwordFieldName] === 'string'
      ? input[passwordFieldName]
      : undefined
  }

  if (inputArgument.value.kind !== Kind.OBJECT) return undefined

  const passwordField = inputArgument.value.fields.find(
    (objectField) => objectField.name.value === passwordFieldName,
  )
  if (!passwordField) return undefined

  if (passwordField.value.kind === Kind.STRING) {
    return passwordField.value.value
  }

  if (passwordField.value.kind === Kind.VARIABLE) {
    const value = variableValues[passwordField.value.name.value]
    return typeof value === 'string' ? value : undefined
  }

  return undefined
}

const findPasswordsToCheck = (
  document: DocumentNode,
  selectionSet: SelectionSetNode,
  variableValues: Record<string, unknown>,
): string[] => {
  const fragments = getFragmentDefinitions(document)

  return PASSWORD_MUTATIONS.flatMap(({ fieldName, passwordFieldName }) =>
    findFields(selectionSet, fieldName, fragments, new Set())
      .map((field) => extractPassword(field, passwordFieldName, variableValues))
      .filter((password): password is string => password !== undefined),
  )
}

const PasswordStrengthPlugin: GraphileConfig.Plugin = {
  name: 'PasswordStrengthPlugin',
  version: '0.0.0',
  grafserv: {
    middleware: {
      async processGraphQLRequestBody(next, event) {
        if (event.request?.method !== 'POST') {
          return next()
        }

        const resolved = resolveOperation(event)
        const passwords =
          resolved?.operation.operation === 'mutation'
            ? findPasswordsToCheck(
                resolved.document,
                resolved.operation.selectionSet,
                isRecord(event.body.variableValues)
                  ? event.body.variableValues
                  : {},
              )
            : []

        for (const password of passwords) {
          const { score } = zxcvbn.check(password)
          if (score < PASSWORD_SCORE_MINIMUM) {
            const requestContext = event.request?.requestContext
            if (requestContext?.node?.res) {
              requestContext.node.res.statusCode = 422
            }

            throw new Error('Password is too weak')
          }
        }

        return next()
      },
    },
  },
}

export const PasswordStrengthPreset: GraphileConfig.Preset = {
  plugins: [PasswordStrengthPlugin],
}
