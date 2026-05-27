import type { ProcessGraphQLRequestBodyEvent } from 'postgraphile/grafserv'

const IS_DEV = process.env['NODE_ENV'] !== 'production'
const logger = {
  debug: (message: string, data?: unknown) => {
    if (IS_DEV) {
      console.debug(`[turnstile] ${message}`, data)
    }
  },
  error: (message: string, data?: unknown) => {
    console.error(`[turnstile] ${message}`, data)
  },
}
const setStatusCode = (
  event: ProcessGraphQLRequestBodyEvent,
  statusCode: number,
) => {
  const requestContext = event.request?.requestContext
  if (requestContext?.node?.res) {
    requestContext.node.res.statusCode = statusCode
  }
}

const TurnstilePlugin: GraphileConfig.Plugin = {
  name: 'TurnstilePlugin',
  version: '0.0.0',
  grafserv: {
    middleware: {
      async processGraphQLRequestBody(next, event) {
        logger.debug('Request method', event.request?.method)
        logger.debug('Request body', event.body)
        logger.debug(
          'Request headers',
          event.request?.requestContext.node?.req.headers,
        )

        if (event.request?.method !== 'POST') {
          logger.debug('Skipping verification for non-POST request.')
          return next()
        }

        // TODO: only test turnstile for certain operations, e.g. authentication and account registration
        const key = event.request.getHeader('x-turnstile-key')
        const verificationTimeoutMs = 5000
        const controller = new AbortController()
        const timeout = setTimeout(
          () => controller.abort(),
          verificationTimeoutMs,
        )
        let result: Response
        logger.debug('Received token', key)

        try {
          result = await fetch(
            'http://vibetype:3000/api/internal/service/postgraphile/authentication',
            {
              body: JSON.stringify(event.body),
              headers: {
                ...(key ? { 'x-turnstile-key': key } : {}),
                'content-type': 'application/json',
              },
              method: event.request.method,
              signal: controller.signal,
            },
          )
        } catch (error) {
          logger.error('Verification request failed', error)

          if (
            error instanceof Error &&
            (error.name === 'AbortError' || controller.signal.aborted)
          ) {
            setStatusCode(event, 504)
            throw new Error('Turnstile verification timed out', {
              cause: error,
            })
          }

          setStatusCode(event, 503)
          throw new Error('Turnstile verification service unavailable', {
            cause: error,
          })
        } finally {
          clearTimeout(timeout)
        }
        if (IS_DEV) {
          logger.debug('Verification response', {
            result,
            body: await result.clone().text(),
          })
        }

        if (!result.ok) {
          logger.error('Verification failed', {
            status: result.status,
            statusText: result.statusText,
          })
          setStatusCode(event, 401)

          throw new Error('Turnstile verification failed')
        }

        logger.debug('Verification succeeded')
        return next()
      },
    },
  },
}

export const TurnstilePreset: GraphileConfig.Preset = {
  plugins: [TurnstilePlugin],
}
