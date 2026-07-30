import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Nest's own startup logs are buffered until the pino logger is attached,
    // so bootstrap output is structured too rather than being the one
    // unparseable section of the log.
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');

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
