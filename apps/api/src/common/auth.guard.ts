import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/** The caller, as the database describes them now — not as the token remembers. */
export interface AuthenticatedUser {
  sub: string;
  name?: string;
  role: string;
  /** Outlet the user is pinned to, or null for unrestricted. */
  outletId: string | null;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwt: JwtService,
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException();

    let claims: { sub?: string };
    try {
      claims = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException();
    }
    if (!claims?.sub) throw new UnauthorizedException();

    // Read the user rather than trusting the token's copy of them. Tokens last
    // twelve hours, so without this a cashier who was deactivated — or
    // demoted — at the start of a shift keeps the access they had when they
    // signed in, for the rest of the day. One primary-key lookup per request
    // is a real cost and a small one; the alternative is a revocation list,
    // which is the same query wearing a hat.
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, name: true, role: true, active: true, outletId: true },
    });
    if (!user?.active) throw new UnauthorizedException();

    const authenticated: AuthenticatedUser = {
      sub: user.id,
      name: user.name,
      role: user.role,
      outletId: user.outletId,
    };
    req.user = authenticated;

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}

/**
 * The outlet a request may act on, refusing any attempt to reach another.
 *
 * Every outlet-scoped endpoint used to take the id straight from the query
 * string, so a cashier at one shop could read another's takings, list its
 * stock, or move it — the id was the only thing identifying the outlet and
 * nothing checked it belonged to the caller.
 *
 * A user with no outlet is unrestricted, which is how an owner sees the whole
 * business; they must still name an outlet where one is required, rather than
 * silently getting all of them.
 */
export function resolveOutletScope(user: AuthenticatedUser, requested?: string): string | undefined {
  if (!user.outletId) return requested || undefined;
  if (requested && requested !== user.outletId) {
    throw new ForbiddenException('That outlet is not yours');
  }
  return user.outletId;
}

/** As above, where an outlet must be named. */
export function requireOutletScope(user: AuthenticatedUser, requested?: string): string {
  const scope = resolveOutletScope(user, requested);
  if (!scope) throw new ForbiddenException('An outlet must be specified');
  return scope;
}
