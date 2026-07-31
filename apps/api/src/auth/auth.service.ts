import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One answer for every way signing in can fail.
 *
 * Distinguishing "no such account" from "wrong password" is a way to harvest
 * valid emails, and distinguishing either from "locked out" tells an attacker
 * when to back off rather than when to stop.
 */
const REJECTED = 'Invalid credentials';

/**
 * Attempt ceilings, per identity and per source address, over a rolling window.
 *
 * Two counters because they close different doors: the per-identity one stops a
 * single account being ground down from anywhere, and the per-address one stops
 * one client working through a list of accounts. Neither is generous — a
 * cashier who has genuinely forgotten their password asks a manager, and waits
 * a few minutes at worst.
 */
const LIMITS = {
  PASSWORD: { perIdentity: 8, perIp: 30 },
  PIN: { perIdentity: Infinity, perIp: 12 },
} as const;

const WINDOW_MS = 10 * 60_000;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async login(email: string, password: string, ip?: string) {
    const identifier = (email ?? '').trim().toLowerCase();
    await this.assertNotThrottled('PASSWORD', identifier, ip);

    const user = identifier ? await this.prisma.user.findUnique({ where: { email: identifier } }) : null;
    // Hash even when there is no user, so the response time does not tell an
    // attacker which emails exist. bcrypt.compare against a syntactically valid
    // hash costs the same as the real thing.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await bcrypt.compare(password ?? '', hash);

    if (!user || !user.active || !matches) {
      await this.record('PASSWORD', identifier, ip, false);
      throw new UnauthorizedException(REJECTED);
    }

    await this.record('PASSWORD', identifier, ip, true);
    const token = await this.jwt.signAsync({ sub: user.id, role: user.role, name: user.name });
    await this.prisma.auditLog.create({
      data: { userId: user.id, action: 'LOGIN', entity: 'User', entityId: user.id },
    });
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  /**
   * Terminal fast switch-user by 6-digit PIN.
   *
   * A PIN identifies nobody until it matches, so every active PIN holder has to
   * be compared — bcrypt is deliberately slow, which makes this endpoint the
   * most expensive one in the API and the reason it is rate limited hardest.
   *
   * Two people sharing a PIN is refused rather than resolved. Six digits across
   * a staff list collide sooner than intuition suggests, and the old code took
   * whoever the database happened to return first: every sale, void and cash
   * movement thereafter attributed to a coin flip.
   */
  async pinLogin(pin: string, ip?: string) {
    await this.assertNotThrottled('PIN', null, ip);

    const holders = await this.prisma.user.findMany({
      where: { active: true, pin: { not: null } },
      select: { id: true, name: true, role: true, pin: true },
    });

    const matched: { id: string; name: string; role: string }[] = [];
    for (const u of holders) {
      // Not short-circuited: stopping at the first match would make the time
      // taken depend on where in the list the holder sits.
      if (await bcrypt.compare(pin ?? '', u.pin!)) {
        matched.push({ id: u.id, name: u.name, role: u.role });
      }
    }

    if (matched.length !== 1) {
      await this.record('PIN', null, ip, false);
      if (matched.length > 1) {
        await this.prisma.auditLog.create({
          data: {
            action: 'PIN_COLLISION',
            entity: 'User',
            detail: { userIds: matched.map((m) => m.id) },
          },
        });
      }
      throw new UnauthorizedException(REJECTED);
    }

    const user = matched[0];
    await this.record('PIN', null, ip, true);
    const token = await this.jwt.signAsync({ sub: user.id, role: user.role, name: user.name });
    return { token, user: { id: user.id, name: user.name, role: user.role } };
  }

  /**
   * Refuse before spending any time on the credential. Counting only failures
   * means a working terminal is never throttled by its own traffic, and a
   * successful sign-in clears the slate for that identity.
   */
  private async assertNotThrottled(kind: 'PASSWORD' | 'PIN', identifier: string | null, ip?: string) {
    const since = new Date(Date.now() - WINDOW_MS);
    const limits = LIMITS[kind];

    if (identifier && Number.isFinite(limits.perIdentity)) {
      const failures = await this.prisma.loginAttempt.count({
        where: { kind, identifier, success: false, createdAt: { gte: since } },
      });
      if (failures >= limits.perIdentity) throw new UnauthorizedException(REJECTED);
    }

    if (ip) {
      const failures = await this.prisma.loginAttempt.count({
        where: { kind, ip, success: false, createdAt: { gte: since } },
      });
      if (failures >= limits.perIp) throw new UnauthorizedException(REJECTED);
    }
  }

  private async record(
    kind: 'PASSWORD' | 'PIN',
    identifier: string | null,
    ip: string | undefined,
    success: boolean,
  ) {
    if (success && identifier) {
      // Clear the identity's failures so a fumbled password followed by the
      // right one does not leave the account part-way to a lockout.
      await this.prisma.loginAttempt.deleteMany({ where: { kind, identifier, success: false } });
    }
    await this.prisma.loginAttempt.create({
      data: { kind, identifier, ip: ip ?? null, success },
    });
  }
}

/**
 * A real bcrypt hash of a value nobody will present, used to spend the same
 * time on a login for an address that does not exist as one that does.
 */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
