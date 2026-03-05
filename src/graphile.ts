import { defaultMaskError } from 'grafserv'
import { jwtVerify, importSPKI } from 'jose'

import { getValidatedEnvironment } from './environment.ts'

const ENVIRONMENT = getValidatedEnvironment([
  'POSTGRAPHILE_JWT_PUBLIC_KEY',
] as const)
const HTTP_STATUS_UNAUTHORIZED = 401
export const JWT_ALGORITHM = 'RS256'
export const JWT_AUDIENCE = 'postgraphile'
const JWT_CLAIMS = [
  'attendances',
  'exp',
  'guests',
  'jti',
  'role',
  'sub',
  'username',
]
export const JWT_ISSUER = 'postgraphile'
const JWT_PUBLIC_KEY = await importSPKI(
  ENVIRONMENT.POSTGRAPHILE_JWT_PUBLIC_KEY,
  JWT_ALGORITHM,
)
const ROLE_DEFAULT = 'vibetype_anonymous'

export const grafastContext: NonNullable<
  GraphileConfig.GrafastOptions['context']
> = async (requestContext, args) => {
  const req = requestContext.node?.req
  const header = req?.headers?.authorization ?? ''
  const [, token] = header.split(' ')

  const pgSettings = {
    ...args.contextValue.pgSettings,
  }

  if (token) {
    try {
      const claims = await jwtVerify<{ role?: string }>(token, JWT_PUBLIC_KEY, {
        algorithms: [JWT_ALGORITHM],
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER,
      })

      pgSettings['role'] = claims.payload.role || ROLE_DEFAULT

      for (const [key, value] of Object.entries(claims.payload)) {
        if (!JWT_CLAIMS.includes(key)) continue
        if (typeof value === 'undefined' || value === null) continue
        pgSettings[`jwt.claims.${key}`] = Array.isArray(value)
          ? JSON.stringify(value)
          : String(value)
      }
    } catch (e) {
      if (requestContext.node) {
        requestContext.node.res.statusCode = HTTP_STATUS_UNAUTHORIZED
      }
      throw new Error('JWT verification failed', { cause: e })
    }
  }

  return {
    ...args.contextValue,
    pgSettings,
  }
}

export const grafservMaskError: NonNullable<
  GraphileConfig.GrafservOptions['maskError']
> = (error) => {
  const maskedError = defaultMaskError(error)

  if (
    error.originalError &&
    'code' in error.originalError &&
    typeof error.originalError.code === 'string' &&
    error.originalError.code.match(/^VT[A-Z]{3}$/)
  ) {
    maskedError.extensions['errcode'] = error.originalError.code
  }

  return maskedError
}
