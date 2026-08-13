import ZxcvbnCore from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnDePackage from '@zxcvbn-ts/language-de'
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en'
import { Kind } from 'graphql'
import type { FieldNode, OperationDefinitionNode } from 'graphql'

import { resolveOperation } from './graphqlOperation.ts'

const { ZxcvbnFactory } = ZxcvbnCore

// TODO: this configuration is duplicated in vibetype's app/utils/passwordStrength.ts,
// which risks the two services silently drifting apart. Consider extracting it into a shared
// @maevsi package so both consume the same dictionaries and score threshold.

// Mutations that set a new password, and the `input` field carrying it.
const PASSWORD_MUTATIONS = [
  { fieldName: 'accountPasswordChange', passwordFieldName: 'passwordNew' },
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

const findField = (
  operation: OperationDefinitionNode,
  fieldName: string,
): FieldNode | undefined =>
  operation.selectionSet.selections.find(
    (selection): selection is FieldNode =>
      selection.kind === Kind.FIELD && selection.name.value === fieldName,
  )

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
  operation: OperationDefinitionNode,
  variableValues: Record<string, unknown>,
): string[] =>
  PASSWORD_MUTATIONS.flatMap(({ fieldName, passwordFieldName }) => {
    const field = findField(operation, fieldName)
    if (!field) return []

    const password = extractPassword(field, passwordFieldName, variableValues)
    return password === undefined ? [] : [password]
  })

const PasswordStrengthPlugin: GraphileConfig.Plugin = {
  name: 'PasswordStrengthPlugin',
  version: '0.0.0',
  grafserv: {
    middleware: {
      async processGraphQLRequestBody(next, event) {
        if (event.request?.method !== 'POST') {
          return next()
        }

        const operation = resolveOperation(event)
        const passwords =
          operation?.operation === 'mutation'
            ? findPasswordsToCheck(
                operation,
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
