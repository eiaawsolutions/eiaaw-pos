import 'reflect-metadata';
import type { ServerResponse } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own startup logs are buffered until the pino logger is attached,
    // so bootstrap output is structured too rather than being the one
    // unparseable section of the log.
    bufferLogs: true,
    // Keep the body as it arrived, for the PSP webhook. A signature has to be
    // checked against the bytes that were signed, not against a re-serialised
    // copy of the parsed object.
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');

  // An order is a few kilobytes; a catalog import is the only large body and
  // arrives as text. 1 MB is generous for both and stops an unauthenticated
  // endpoint being handed a hundred megabytes to parse. Configured through
  // Nest rather than by adding another express.json() — a second parser would
  // consume the stream and leave the webhook without its raw bytes.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });

  // Set here rather than pulling in helmet: this is the whole list a JSON API
  // behind a separate frontend needs, and each one is easier to justify when
  // it is written down.
  app.use((_req: unknown, res: ServerResponse, next: () => void) => {
    // Nothing here is meant to be framed, embedded, or sniffed into a
    // different content type.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    // A terminal's URL can carry an order id; do not hand it to third parties.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    // The API is HTTPS-only in every environment that is not a laptop.
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    // Express advertises itself by default. Version disclosure is free
    // reconnaissance.
    res.removeHeader('X-Powered-By');
    next();
  });

  // A terminal mid-sale must not have its connection cut. Shutdown hooks let
  // Nest drain in-flight requests and close the Prisma pool before exit —
  // Railway sends SIGTERM on every deploy, and without this a redeploy during
  // trading drops whatever was in flight.
  app.enableShutdownHooks();

  const origins = process.env.WEB_ORIGIN?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (!origins?.length) {
    // The previous default was `?? true`, which reflects *any* origin with
    // credentials enabled. Failing closed is the only safe default for a
    // service that issues session tokens.
    throw new Error(
      'WEB_ORIGIN is not set. Set it to the terminal origin, e.g. https://pos.example.com ' +
        '(comma-separated for several). Refusing to start with permissive CORS.',
    );
  }

  app.enableCors({ origin: origins, credentials: true });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log({ port, origins }, 'EIAAW POS API listening');
}

bootstrap();
