import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CanActivate, Controller, ExecutionContext, Get, INestApplication, UseGuards } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard, Roles } from '../src/common/auth.guard';

const SECRET = 'guard-test-secret';

/**
 * What AuthGuard left on the request, captured by a guard that runs after it.
 *
 * A `@Req()` parameter would read better, but Nest's parameter decorators are a
 * legacy TypeScript feature the test transform does not enable: it looks for a
 * tsconfig that opts in, resolves that per file, and apps/api's build config
 * deliberately scopes `include` to src. A probe controller declared in a test
 * file therefore fails to parse at the first `@Req()`. Guards need only class
 * and method decorators, which parse everywhere.
 */
let seenUser: unknown;

class CaptureUser implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    seenUser = ctx.switchToHttp().getRequest().user;
    return true;
  }
}

/**
 * Probe routes. A real Nest pipeline rather than a hand-rolled ExecutionContext:
 * most of what can go wrong in a guard is in the wiring — how the header
 * arrives, how @Roles metadata resolves between handler and class — and a mock
 * context asserts only that the body of the method does what it says.
 */
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ global: true, secret: SECRET, signOptions: { expiresIn: '1h' } })],
      controllers: [ProbeController, VaultController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app?.close();
  });

  const tokenFor = (claims: Record<string, unknown>) => jwt.sign(claims);
  const owner = () => tokenFor({ sub: 'u-owner', role: 'OWNER', name: 'Owner' });
  const cashier = () => tokenFor({ sub: 'u-cashier', role: 'CASHIER', name: 'Cashier' });

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
      await request(app.getHttpServer()).get('/probe/open').set('Authorization', owner()).expect(401);
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
      const forged = new JwtService({ secret: 'not-our-secret' }).sign({ sub: 'u1', role: 'OWNER' });
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('refuses an expired token', async () => {
      const stale = jwt.sign({ sub: 'u1', role: 'OWNER' }, { expiresIn: '-1s' });
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${stale}`)
        .expect(401);
    });

    it('refuses a token whose signature has been tampered with', async () => {
      const [header, payload] = owner().split('.');
      const tampered = `${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
    });

    it('refuses an unsigned "alg: none" token', async () => {
      // The classic JWT forgery: strip the signature and declare no algorithm.
      const none = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const forged = `${none({ alg: 'none', typ: 'JWT' })}.${none({ sub: 'u1', role: 'OWNER' })}.`;
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
    });

    it('admits a valid token and puts the claims on the request', async () => {
      seenUser = undefined;
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${owner()}`)
        .expect(200);
      expect(seenUser).toMatchObject({ sub: 'u-owner', role: 'OWNER', name: 'Owner' });
    });

    it('says nothing about why a credential was rejected', async () => {
      // Expired, forged and malformed must be indistinguishable: anything that
      // narrows it down tells an attacker which half of the guess was right.
      const bodies = await Promise.all(
        [
          'Bearer not-a-token',
          `Bearer ${jwt.sign({ sub: 'u1' }, { expiresIn: '-1s' })}`,
          `Bearer ${new JwtService({ secret: 'other' }).sign({ sub: 'u1' })}`,
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

  describe('role requirements', () => {
    it('lets any authenticated user through a route with no @Roles', async () => {
      await request(app.getHttpServer())
        .get('/probe/open')
        .set('Authorization', `Bearer ${cashier()}`)
        .expect(200);
    });

    it('admits a role on the list', async () => {
      await request(app.getHttpServer())
        .get('/probe/managers')
        .set('Authorization', `Bearer ${owner()}`)
        .expect(200);
    });

    it('refuses a role that is not, with 403 rather than 401', async () => {
      // The distinction matters to the terminal: 401 means log in again, 403
      // means fetch someone who can.
      await request(app.getHttpServer())
        .get('/probe/managers')
        .set('Authorization', `Bearer ${cashier()}`)
        .expect(403);
    });

    it('refuses a token carrying no role claim at all', async () => {
      const roleless = tokenFor({ sub: 'u-nobody' });
      await request(app.getHttpServer())
        .get('/probe/managers')
        .set('Authorization', `Bearer ${roleless}`)
        .expect(403);
    });

    it('refuses a role invented in the token', async () => {
      const invented = tokenFor({ sub: 'u1', role: 'SUPERUSER' });
      await request(app.getHttpServer())
        .get('/probe/managers')
        .set('Authorization', `Bearer ${invented}`)
        .expect(403);
    });

    it('treats @Roles() with no arguments as no restriction', async () => {
      await request(app.getHttpServer())
        .get('/probe/nobody')
        .set('Authorization', `Bearer ${cashier()}`)
        .expect(200);
    });

    it('applies a class-level @Roles to a handler that declares none', async () => {
      await request(app.getHttpServer())
        .get('/vault/inherited')
        .set('Authorization', `Bearer ${owner()}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/vault/inherited')
        .set('Authorization', `Bearer ${cashier()}`)
        .expect(403);
    });

    it('lets the handler override the class rather than adding to it', async () => {
      // getAllAndOverride, not getAllAndMerge: the nearest declaration wins
      // outright, so an owner is refused a route narrowed to cashiers.
      await request(app.getHttpServer())
        .get('/vault/overridden')
        .set('Authorization', `Bearer ${cashier()}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/vault/overridden')
        .set('Authorization', `Bearer ${owner()}`)
        .expect(403);
    });

    it('checks the credential before the role', async () => {
      // A bad token on a role-guarded route is 401, not 403 — otherwise the
      // response distinguishes "your token is junk" from "you are not senior
      // enough", which is a probe for which roles guard what.
      await request(app.getHttpServer())
        .get('/probe/managers')
        .set('Authorization', 'Bearer rubbish')
        .expect(401);
    });
  });
});
