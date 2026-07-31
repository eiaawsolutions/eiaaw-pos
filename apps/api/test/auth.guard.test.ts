import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  INestApplication,
  UseGuards,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { prisma } from './setup';
import { makeOutlet, makeUser } from './fixtures';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AuthGuard,
  Roles,
  requireOutletScope,
  resolveOutletScope,
  type AuthenticatedUser,
} from '../src/common/auth.guard';

const SECRET = 'guard-test-secret';

/**
 * What AuthGuard left on the request, captured by a guard that runs after it.
 *
 * A `@Req()` parameter would read better, but Nest's parameter decorators are a
 * legacy TypeScript feature the test transform only enables where it finds a
 * tsconfig saying so — see test/tsconfig.json, which exists for exactly this.
 * Guards need only class and method decorators.
 */
let seenUser: AuthenticatedUser | undefined;

class CaptureUser implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    seenUser = ctx.switchToHttp().getRequest().user;
    return true;
  }
}

@Controller('probe')
@UseGuards(AuthGuard, CaptureUser)
class ProbeController {
  @Get('open')
  open() {
    return { ok: true };
  }

  @Get('managers')
  @Roles('OWNER', 'MANAGER')
  managers() {
    return { ok: true };
  }

  @Get('nobody')
  @Roles()
  nobody() {
    return { ok: true };
  }
}

/** Roles declared on the class, to pin down which one wins. */
@Controller('vault')
@UseGuards(AuthGuard)
@Roles('OWNER')
class VaultController {
  @Get('inherited')
  inherited() {
    return { ok: true };
  }

  @Get('overridden')
  @Roles('CASHIER')
  overridden() {
    return { ok: true };
  }
}

describe('AuthGuard', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let ownerId: string;
  let cashierId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ global: true, secret: SECRET, signOptions: { expiresIn: '1h' } })],
      controllers: [ProbeController, VaultController],
      providers: [{ provide: PrismaService, useValue: prisma }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    // The guard reads the caller from the database now, so the token alone is
    // no longer enough to be anybody.
    ownerId = (await makeUser({ role: 'OWNER' })).id;
    cashierId = (await makeUser({ role: 'CASHIER' })).id;
    seenUser = undefined;
  });

  const bearer = (sub: string) => `Bearer ${jwt.sign({ sub })}`;
  const owner = () => bearer(ownerId);
  const cashier = () => bearer(cashierId);

  describe('presenting a token', () => {
    it('refuses a request with no Authorization header', async () => {
      await request(app.getHttpServer()).get('/probe/open').expect(401);
    });

    it('refuses a header that is not a Bearer credential', async () => {
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .expect(401);
    });

    it('refuses a bare token with no scheme', async () => {
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', jwt.sign({ sub: ownerId }))
        .expect(401);
    });

    it('refuses an empty Bearer credential', async () => {
      await request(app.getHttpServer()).get('/probe/open').set('Authorization', 'Bearer ').expect(401);
    });

    it('refuses a token that is not a JWT at all', async () => {
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);
    });

    it('refuses a token signed with another secret', async () => {
      const forged = new JwtService({ secret: 'not-our-secret' }).sign({ sub: ownerId });
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('refuses an expired token', async () => {
      const stale = jwt.sign({ sub: ownerId }, { expiresIn: '-1s' });
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${stale}`)
        .expect(401);
    });

    it('refuses a token whose signature has been tampered with', async () => {
      const [header, payload] = jwt.sign({ sub: ownerId }).split('.');
      const tampered = `${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });

    it('refuses an unsigned "alg: none" token', async () => {
      const none = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const forged = `${none({ alg: 'none', typ: 'JWT' })}.${none({ sub: ownerId })}.`;
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('refuses a well-formed token with no subject', async () => {
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${jwt.sign({ role: 'OWNER' })}`)
        .expect(401);
    });

    it('admits a valid token and puts the caller on the request', async () => {
      await request(app.getHttpServer()).get('/probe/open').set('Authorization', owner()).expect(200);
      expect(seenUser).toMatchObject({ sub: ownerId, role: 'OWNER' });
    });

    it('says nothing about why a credential was rejected', async () => {
      const bodies = await Promise.all(
        [
          'Bearer not-a-token',
          `Bearer ${jwt.sign({ sub: ownerId }, { expiresIn: '-1s' })}`,
          `Bearer ${new JwtService({ secret: 'other' }).sign({ sub: ownerId })}`,
        ].map((auth) =>
          request(app.getHttpServer())
            .get('/probe/open')
            .set('Authorization', auth)
            .then((r) => r.body.message),
        ),
      );
      expect(new Set(bodies).size).toBe(1);
    });
  });

  describe('the token is not the last word', () => {
    it('refuses a user deactivated since the token was issued', async () => {
      // Tokens last twelve hours. Without this, someone let go at the start of
      // a shift keeps everything they had until the token expires.
      const token = cashier();
      await request(app.getHttpServer()).get('/probe/open').set('Authorization', token).expect(200);

      await prisma.user.update({ where: { id: cashierId }, data: { active: false } });
      await request(app.getHttpServer()).get('/probe/open').set('Authorization', token).expect(401);
    });

    it('refuses a user who no longer exists', async () => {
      const token = cashier();
      await prisma.user.delete({ where: { id: cashierId } });
      await request(app.getHttpServer()).get('/probe/open').set('Authorization', token).expect(401);
    });

    it('takes the role from the database, not from the claim', async () => {
      // A token forged with role: OWNER buys nothing, and a genuine demotion
      // takes effect on the next request rather than at expiry.
      const claimsOwner = `Bearer ${jwt.sign({ sub: cashierId, role: 'OWNER' })}`;
      await request(app.getHttpServer()).get('/probe/managers').set('Authorization', claimsOwner).expect(403);
    });

    it('applies a promotion without waiting for a new token', async () => {
      const token = cashier();
      await request(app.getHttpServer()).get('/probe/managers').set('Authorization', token).expect(403);

      await prisma.user.update({ where: { id: cashierId }, data: { role: 'MANAGER' } });
      await request(app.getHttpServer()).get('/probe/managers').set('Authorization', token).expect(200);
    });

    it('carries the outlet the user is pinned to', async () => {
      const outlet = await makeOutlet();
      await prisma.user.update({ where: { id: cashierId }, data: { outletId: outlet.id } });

      await request(app.getHttpServer()).get('/probe/open').set('Authorization', cashier()).expect(200);
      expect(seenUser?.outletId).toBe(outlet.id);
    });
  });

  describe('role requirements', () => {
    it('lets any authenticated user through a route with no @Roles', async () => {
      await request(app.getHttpServer()).get('/probe/open').set('Authorization', cashier()).expect(200);
    });

    it('admits a role on the list', async () => {
      await request(app.getHttpServer()).get('/probe/managers').set('Authorization', owner()).expect(200);
    });

    it('refuses a role that is not, with 403 rather than 401', async () => {
      await request(app.getHttpServer()).get('/probe/managers').set('Authorization', cashier()).expect(403);
    });

    it('treats @Roles() with no arguments as no restriction', async () => {
      await request(app.getHttpServer()).get('/probe/nobody').set('Authorization', cashier()).expect(200);
    });

    it('applies a class-level @Roles to a handler that declares none', async () => {
      await request(app.getHttpServer()).get('/vault/inherited').set('Authorization', owner()).expect(200);
      await request(app.getHttpServer()).get('/vault/inherited').set('Authorization', cashier()).expect(403);
    });

    it('lets the handler override the class rather than adding to it', async () => {
      await request(app.getHttpServer()).get('/vault/overridden').set('Authorization', cashier()).expect(200);
      await request(app.getHttpServer()).get('/vault/overridden').set('Authorization', owner()).expect(403);
    });

    it('checks the credential before the role', async () => {
      await request(app.getHttpServer())
        .get('/probe/managers')
        .set('Authorization', 'Bearer rubbish')
        .expect(401);
    });
  });
});

describe('outlet scope', () => {
  const pinned: AuthenticatedUser = { sub: 'u1', role: 'CASHIER', outletId: 'outlet-a' };
  const roaming: AuthenticatedUser = { sub: 'u2', role: 'OWNER', outletId: null };

  it('confines a pinned user to their own outlet whatever they ask for', () => {
    expect(resolveOutletScope(pinned, undefined)).toBe('outlet-a');
    expect(resolveOutletScope(pinned, 'outlet-a')).toBe('outlet-a');
    expect(() => resolveOutletScope(pinned, 'outlet-b')).toThrow(ForbiddenException);
  });

  it('lets an unpinned user choose, including everything', () => {
    expect(resolveOutletScope(roaming, 'outlet-b')).toBe('outlet-b');
    expect(resolveOutletScope(roaming, undefined)).toBeUndefined();
  });

  it('treats an empty outlet id as no request rather than as one', () => {
    expect(resolveOutletScope(roaming, '')).toBeUndefined();
  });

  it('insists on an outlet where one is required', () => {
    expect(requireOutletScope(pinned, undefined)).toBe('outlet-a');
    expect(() => requireOutletScope(roaming, undefined)).toThrow(ForbiddenException);
    expect(requireOutletScope(roaming, 'outlet-b')).toBe('outlet-b');
  });
});
