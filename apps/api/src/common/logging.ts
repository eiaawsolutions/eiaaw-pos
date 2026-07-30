import type { Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';

/**
 * Structured logging configuration.
 *
 * JSON in production so Railway's log drain and any downstream aggregator can
 * parse it; pretty-printed locally so it stays readable while developing.
 *
 * Every log line carries a request id. When a sale is disputed, "what happened
 * to order 20260730-00001" has to be answerable from the logs, and that means
 * correlating the HTTP request with everything the services did underneath it.
 */

/** Header names carrying secrets or personal data — never logged. */
const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-signature"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  // PDPA: a customer's phone or email must not end up in an aggregator.
  'req.body.password',
  'req.body.pin',
  'req.body.phone',
  'req.body.email',
  'req.body.answers',
  // Uploaded catalog documents can run to megabytes and may contain
  // commercially sensitive pricing.
  'req.body.sourceText',
];

export function loggerConfig(): Params {
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),

      // Railway and most aggregators expect one JSON object per line.
      transport: isProduction
        ? undefined
        : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss.l' } },

      redact: { paths: REDACTED, censor: '[redacted]' },

      // Prefer an inbound correlation id so a request can be followed across
      // the terminal, the API and the worker.
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'] ?? req.headers['x-correlation-id'];
        const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },

      // A POS is a hot path — a full request/response dump per sale is noise
      // and a PDPA liability. Log the shape, not the contents.
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          // Which terminal, so a misbehaving register is identifiable.
          register: req.headers['x-register-id'],
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },

      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        // Health checks every 30s would otherwise drown the log.
        return 'info';
      },

      autoLogging: {
        ignore: (req) => req.url === '/api/health' || req.url === '/api/health/live',
      },
    },
  };
}
