import { defaultMaskError } from 'grafserv'
import { importSPKI, jwtVerify } from 'jose'

const HTTP_STATUS_UNAUTHORIZED = 401
export const JWT_ALGORITHM = 'ES256'
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
const JWT_PUBLIC_KEY = process.env['POSTGRAPHILE_JWT_PUBLIC_KEY']
const JWT_SECRET_KEY = process.env['POSTGRAPHILE_JWT_SECRET_KEY']

if (Boolean(JWT_PUBLIC_KEY) !== Boolean(JWT_SECRET_KEY)) {
  throw new Error(
    'Both POSTGRAPHILE_JWT_PUBLIC_KEY and POSTGRAPHILE_JWT_SECRET_KEY must be set to enable JWT authentication',
  )
}

// JWT keys, present when JWT authentication is enabled
const jwtKeys =
  JWT_PUBLIC_KEY && JWT_SECRET_KEY
    ? { publicKey: JWT_PUBLIC_KEY, secretKey: JWT_SECRET_KEY }
    : undefined

export const isJwtEnabled = Boolean(jwtKeys)

// The secret key used to sign JWTs, present when JWT authentication is enabled
export const jwtSecretKey = jwtKeys?.secretKey

const jwtPublicKey = jwtKeys
  ? await importSPKI(jwtKeys.publicKey, JWT_ALGORITHM)
  : undefined

// The role for a request that resolves no role of its own.
// With JWT authentication enabled, this is the fallback for a valid token without a `role` claim; requests without a token keep running as the connection role.
// With JWT authentication disabled, this is the role for every request.
const defaultRole = process.env['POSTGRAPHILE_DEFAULT_ROLE']

export const grafastContext: NonNullable<
  GraphileConfig.GrafastOptions['context']
> = async (requestContext, args) => {
  const req = requestContext.node?.req
  const header = req?.headers?.authorization ?? ''
  const [, token] = header.split(' ')

  const pgSettings = {
    ...args.contextValue.pgSettings,
  }

  if (token && isJwtEnabled && jwtPublicKey) {
    try {
      const claims = await jwtVerify<{ role?: string }>(token, jwtPublicKey, {
        algorithms: [JWT_ALGORITHM],
        audience: JWT_AUDIENCE,
        issuer: JWT_ISSUER,
      })

      const role = claims.payload.role || defaultRole
      if (role) {
        pgSettings['role'] = role
      }

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
      throw Object.assign(new Error('JWT verification failed', { cause: e }), {
        statusCode: HTTP_STATUS_UNAUTHORIZED,
      })
    }
  } else if (!isJwtEnabled && defaultRole) {
    pgSettings['role'] = defaultRole
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
