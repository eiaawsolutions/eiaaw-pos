import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { HealthController } from '../src/common/health.controller';
import { PrismaService } from '../src/prisma/prisma.service';
import { prisma } from './setup';

/**
 * The endpoints an orchestrator trusts to decide whether this process receives
 * money. The previous implementation returned {ok:true} unconditionally, so an
 * instance that had lost its database stayed in rotation and accepted sales it
 * could not record. These tests exist to keep that from coming back.
 */
describe('health endpoints', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('readiness — /api/health', () => {
    it('reports up, with the database as a named check', async () => {
      const res = await request(app.getHttpServer()).get('/api/health').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.info.database.status).toBe('up');
      // Surfaced so a degrading database is visible before it fails outright.
      expect(res.body.info.database.responseTimeMs).toBeTypeOf('number');
    });

    it('reports 503 when the database is unreachable', async () => {
      // A client pointed at a port nothing listens on — the closest stand-in
      // for a database outage that does not disrupt the rest of the suite.
      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const broken = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: 'postgresql://postgres:postgres@127.0.0.1:1/nope',
        }),
      });

      const brokenModule = await Test.createTestingModule({
        imports: [TerminusModule],
        controllers: [HealthController],
        providers: [{ provide: PrismaService, useValue: broken }],
      }).compile();

      const brokenApp = brokenModule.createNestApplication();
      brokenApp.setGlobalPrefix('api');
      await brokenApp.init();

      try {
        const res = await request(brokenApp.getHttpServer()).get('/api/health').expect(503);
        expect(res.body.status).toBe('error');
        expect(res.body.error.database.status).toBe('down');
      } finally {
        await brokenApp.close();
        await broken.$disconnect().catch(() => {});
      }
    });
  });

  describe('liveness — /api/health/live', () => {
    it('answers without touching the database', async () => {
      const res = await request(app.getHttpServer()).get('/api/health/live').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.uptime).toBeTypeOf('number');
    });

    it('stays up even when the database is unreachable', async () => {
      // Liveness must not depend on any external service: restarting every
      // replica over a database blip converts a recoverable outage into a
      // total one.
      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const broken = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: 'postgresql://postgres:postgres@127.0.0.1:1/nope',
        }),
      });

      const brokenModule = await Test.createTestingModule({
        imports: [TerminusModule],
        controllers: [HealthController],
        providers: [{ provide: PrismaService, useValue: broken }],
      }).compile();

      const brokenApp = brokenModule.createNestApplication();
      brokenApp.setGlobalPrefix('api');
      await brokenApp.init();

      try {
        await request(brokenApp.getHttpServer()).get('/api/health/live').expect(200);
      } finally {
        await brokenApp.close();
        await broken.$disconnect().catch(() => {});
      }
    });
  });
});
