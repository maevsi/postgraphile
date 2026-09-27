import * as Sentry from '@sentry/node'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

// Network identity keys the SDK filtered by default up to v10; v11 sends them unless denied.
const PII_DENY_KEYS = ['forwarded', '-ip', 'remote-', 'via', '-user']

if (process.env['SENTRY_DSN']) {
  Sentry.init({
    dataCollection: {
      cookies: false,
      databaseQueryData: false,
      graphQL: { document: false, variables: false },
      httpBodies: [], // TODO: implement scrubbing, enable request bodies collection only then
      httpHeaders: {
        request: { deny: PII_DENY_KEYS },
        response: { deny: PII_DENY_KEYS },
      },
      urlQueryParams: { deny: PII_DENY_KEYS },
      userInfo: false,
    },
    dsn: process.env['SENTRY_DSN'],
    integrations: [nodeProfilingIntegration()],
    profileLifecycle: 'trace',
    profileSessionSampleRate:
      process.env['NODE_ENV'] === 'development' ? 1.0 : 0.1,
    tracesSampleRate: process.env['NODE_ENV'] === 'development' ? 1.0 : 0.1,
  })
} else {
  console.warn('Sentry DSN not found, skipping Sentry initialization')
}
