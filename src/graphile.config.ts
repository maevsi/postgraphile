import postgisPreset from '@graphile/postgis'
import type {} from 'grafserv/node'
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber'
import { makePgService } from 'postgraphile/adaptors/pg'

import { getValidatedEnvironment } from './environment.ts'
import {
  grafastContext,
  grafservMaskError,
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './graphile.ts'

const ENVIRONMENT = getValidatedEnvironment([
  'POSTGRAPHILE_CONNECTION',
  'POSTGRAPHILE_OWNER_CONNECTION',
  'POSTGRAPHILE_JWT_SECRET_KEY',
] as const)
const ENVIRONMENT_DEVELOPMENT = process.env['GRAPHILE_ENV'] === 'development'
const SCHEMA_NAME = 'vibetype'

const preset: GraphileConfig.Preset = {
  extends: [PostGraphileAmberPreset, postgisPreset],
  gather: {
    pgJwtTypes: [`${SCHEMA_NAME}.jwt`],
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
    pgJwtSecret: ENVIRONMENT.POSTGRAPHILE_JWT_SECRET_KEY,
    pgJwtSignOptions: {
      algorithm: JWT_ALGORITHM,
      audience: JWT_AUDIENCE,
      issuer: JWT_ISSUER,
    },
  },
}

export default preset
