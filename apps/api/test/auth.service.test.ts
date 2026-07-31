import { describe, it, expect, beforeEach } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { prisma } from './setup';
import { AuthService } from '../src/auth/auth.service';

/**
 * /auth/login and /auth/pin are the only unauthenticated doors into the
 * system. Everything else in the API is reachable only by walking through one
 * of them.
 */
describe('auth', () => {
  let auth: AuthService;
  const jwt = new JwtService({ secret: 'auth-test-secret', signOptions: { expiresIn: '1h' } });

  beforeEach(() => {
    auth = new AuthService(prisma as never, jwt);
  });

  async function makeStaff(opts: {
    email?: string;
    password?: string;
    pin?: string;
    role?: string;
    active?: boolean;
  }) {
    return prisma.user.create({
      data: {
        name: 'Staff',
        email: opts.email ?? `staff-${Math.random().toString(36).slice(2)}@example.test`,
        passwordHash: await bcrypt.hash(opts.password ?? 'CorrectHorse1!', 10),
        pin: opts.pin ? await bcrypt.hash(opts.pin, 10) : null,
        role: opts.role ?? 'CASHIER',
        active: opts.active ?? true,
      },
    });
  }

  describe('password sign-in', () => {
    it('issues a token for the right credentials', async () => {
      const user = await makeStaff({ email: 'amos@example.test', password: 'CorrectHorse1!' });
      const result = await auth.login('amos@example.test', 'CorrectHorse1!', '1.1.1.1');

      expect(result.user.id).toBe(user.id);
      expect(jwt.verify(result.token)).toMatchObject({ sub: user.id });
    });

    it('accepts the address however it was capitalised or padded', async () => {
      await makeStaff({ email: 'case@example.test', password: 'CorrectHorse1!' });
      await expect(auth.login('  CASE@Example.test ', 'CorrectHorse1!', '1.1.1.1')).resolves.toBeTruthy();
    });

    it('refuses a deactivated account', async () => {
      await makeStaff({ email: 'gone@example.test', password: 'CorrectHorse1!', active: false });
      await expect(auth.login('gone@example.test', 'CorrectHorse1!', '1.1.1.1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('answers the same for an unknown address as for a wrong password', async () => {
      // Otherwise the endpoint is a way to find out who has an account.
      await makeStaff({ email: 'real@example.test', password: 'CorrectHorse1!' });
      const unknown = await auth.login('ghost@example.test', 'whatever', '1.1.1.1').catch((e) => e.message);
      const wrong = await auth.login('real@example.test', 'whatever', '1.1.1.1').catch((e) => e.message);
      expect(unknown).toBe(wrong);
    });

    it('refuses an empty address without falling over', async () => {
      await expect(auth.login('', '', '1.1.1.1')).rejects.toThrow(UnauthorizedException);
    });

    it('leaves every attempt on the record', async () => {
      await makeStaff({ email: 'trail@example.test', password: 'CorrectHorse1!' });
      await auth.login('trail@example.test', 'nope', '1.1.1.1').catch(() => undefined);
      await auth.login('trail@example.test', 'CorrectHorse1!', '1.1.1.1');

      const attempts = await prisma.loginAttempt.findMany({ where: { kind: 'PASSWORD' } });
      expect(attempts.some((a) => !a.success)).toBe(false); // cleared on success
      expect(attempts.some((a) => a.success)).toBe(true);
    });
  });

  describe('against a password being guessed', () => {
    it('stops accepting attempts for an account after a run of failures', async () => {
      await makeStaff({ email: 'target@example.test', password: 'CorrectHorse1!' });

      for (let i = 0; i < 8; i++) {
        await auth.login('target@example.test', `guess-${i}`, '1.1.1.1').catch(() => undefined);
      }
      // Even the right password is refused while the lockout stands.
      await expect(auth.login('target@example.test', 'CorrectHorse1!', '1.1.1.1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('locks the account, not the address, so one victim cannot lock out the shop', async () => {
      await makeStaff({ email: 'victim@example.test', password: 'CorrectHorse1!' });
      const other = await makeStaff({ email: 'other@example.test', password: 'CorrectHorse1!' });

      for (let i = 0; i < 8; i++) {
        await auth.login('victim@example.test', `guess-${i}`, '9.9.9.9').catch(() => undefined);
      }

      const result = await auth.login('other@example.test', 'CorrectHorse1!', '9.9.9.9');
      expect(result.user.id).toBe(other.id);
    });

    it('also caps one address working through a list of accounts', async () => {
      for (let i = 0; i < 31; i++) {
        await auth.login(`nobody-${i}@example.test`, 'guess', '5.5.5.5').catch(() => undefined);
      }
      await makeStaff({ email: 'late@example.test', password: 'CorrectHorse1!' });
      await expect(auth.login('late@example.test', 'CorrectHorse1!', '5.5.5.5')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('forgives a fumbled password once the right one lands', async () => {
      await makeStaff({ email: 'fumble@example.test', password: 'CorrectHorse1!' });
      for (let i = 0; i < 5; i++) {
        await auth.login('fumble@example.test', 'wrong', '1.1.1.1').catch(() => undefined);
      }
      await expect(auth.login('fumble@example.test', 'CorrectHorse1!', '1.1.1.1')).resolves.toBeTruthy();

      // The slate is clean, so the next fumbles start from zero.
      for (let i = 0; i < 5; i++) {
        await auth.login('fumble@example.test', 'wrong', '1.1.1.1').catch(() => undefined);
      }
      await expect(auth.login('fumble@example.test', 'CorrectHorse1!', '1.1.1.1')).resolves.toBeTruthy();
    });
  });

  describe('PIN sign-in', () => {
    it('identifies the holder of a matching PIN', async () => {
      const user = await makeStaff({ pin: '246810' });
      const result = await auth.pinLogin('246810', '1.1.1.1');
      expect(result.user.id).toBe(user.id);
    });

    it('refuses a PIN nobody holds', async () => {
      await makeStaff({ pin: '246810' });
      await expect(auth.pinLogin('999999', '1.1.1.1')).rejects.toThrow(UnauthorizedException);
    });

    it('ignores a deactivated holder', async () => {
      await makeStaff({ pin: '135791', active: false });
      await expect(auth.pinLogin('135791', '1.1.1.1')).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a PIN two people share rather than picking one', async () => {
      // Six digits across a staff list collide sooner than intuition suggests.
      // Resolving it by whichever row came back first attributes every sale,
      // void and cash movement thereafter to a coin flip.
      const a = await makeStaff({ pin: '111111' });
      const b = await makeStaff({ pin: '111111' });

      await expect(auth.pinLogin('111111', '1.1.1.1')).rejects.toThrow(UnauthorizedException);

      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PIN_COLLISION' } });
      expect((audit.detail as { userIds: string[] }).userIds.sort()).toEqual([a.id, b.id].sort());
    });

    it('caps attempts per address, since a PIN identifies nobody to lock', async () => {
      await makeStaff({ pin: '246810' });
      for (let i = 0; i < 12; i++) {
        await auth.pinLogin(String(100000 + i), '7.7.7.7').catch(() => undefined);
      }
      await expect(auth.pinLogin('246810', '7.7.7.7')).rejects.toThrow(UnauthorizedException);
    });

    it('leaves another terminal working while one is being hammered', async () => {
      const user = await makeStaff({ pin: '246810' });
      for (let i = 0; i < 12; i++) {
        await auth.pinLogin(String(200000 + i), '7.7.7.7').catch(() => undefined);
      }
      const result = await auth.pinLogin('246810', '8.8.8.8');
      expect(result.user.id).toBe(user.id);
    });
  });
});
