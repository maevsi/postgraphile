import * as Sentry from '@sentry/node'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

if (process.env['SENTRY_DSN']) {
  Sentry.init({
    dataCollection: {
      userInfo: false,
      httpBodies: [], // TODO: implement scrubbing, enable request bodies collection only then
    },
    dsn: process.env['SENTRY_DSN'],
    enableLogs: true,
    integrations: [nodeProfilingIntegration()],
    profileLifecycle: 'trace',
    profileSessionSampleRate:
      process.env['NODE_ENV'] === 'development' ? 1.0 : 0.1,
    tracesSampleRate: process.env['NODE_ENV'] === 'development' ? 1.0 : 0.1,
  })
} else {
  console.warn('Sentry DSN not found, skipping Sentry initialization')
}
