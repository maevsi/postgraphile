import './instrument.ts'

import postgisPreset from '@graphile/postgis'
import type {} from 'grafserv/node'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { makePgService } from 'postgraphile/adaptors/pg'

import { getValidatedEnvironment } from './environment.ts'
import {
  grafastContext,
  grafservMaskError,
  isJwtEnabled,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
  jwtSecretKey,
} from './graphile.ts'
import { PasswordStrengthPreset } from './presets/passwordStrength.ts'
import { TurnstilePreset } from './presets/turnstile.ts'

const ENVIRONMENT = getValidatedEnvironment([
  'POSTGRAPHILE_CONNECTION',
  'POSTGRAPHILE_OWNER_CONNECTION',
  'POSTGRAPHILE_SCHEMA',
] as const)
const ENVIRONMENT_DEVELOPMENT = process.env['GRAPHILE_ENV'] === 'development'
const SCHEMA_NAME = ENVIRONMENT.POSTGRAPHILE_SCHEMA

const preset: GraphileConfig.Preset = {
  extends: [
    PostGraphileAmberPreset,
    TurnstilePreset,
    PasswordStrengthPreset,
    postgisPreset,
  ],
  gather: {
    ...(isJwtEnabled ? { pgJwtTypes: [`${SCHEMA_NAME}.jwt`] } : {}),
  },
  grafast: {
    context: grafastContext,
    explain: ENVIRONMENT_DEVELOPMENT,
  },
  grafserv: {
    maskError: grafservMaskError,
    watch: ENVIRONMENT_DEVELOPMENT,
  },
  pgServices: [
    makePgService({
      connectionString: ENVIRONMENT.POSTGRAPHILE_CONNECTION,
      poolConfig: {
        statement_timeout: 3000,
      },
      schemas: [SCHEMA_NAME],
      superuserConnectionString: ENVIRONMENT.POSTGRAPHILE_OWNER_CONNECTION,
    }),
  ],
  schema: {
    dontSwallowErrors: !ENVIRONMENT_DEVELOPMENT,
    pgForbidSetofFunctionsToReturnNull: true,
    retryOnInitFail: true, // required to prevent postgraphile from caching a connection failure and never completing startup
    ...(isJwtEnabled && jwtSecretKey
      ? {
          pgJwtSecret: jwtSecretKey,
          pgJwtSignOptions: {
            algorithm: JWT_ALGORITHM,
            audience: JWT_AUDIENCE,
            issuer: JWT_ISSUER,
          },
        }
      : {}),
  },
}

export default preset
