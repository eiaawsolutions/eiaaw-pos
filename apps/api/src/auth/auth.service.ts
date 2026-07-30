import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const token = await this.jwt.signAsync({ sub: user.id, role: user.role, name: user.name });
    await this.prisma.auditLog.create({
      data: { userId: user.id, action: 'LOGIN', entity: 'User', entityId: user.id },
    });
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  /** Terminal fast switch-user by 6-digit PIN */
  async pinLogin(pin: string) {
    const users = await this.prisma.user.findMany({ where: { active: true, pin: { not: null } } });
    for (const u of users) {
      if (u.pin && (await bcrypt.compare(pin, u.pin))) {
        const token = await this.jwt.signAsync({ sub: u.id, role: u.role, name: u.name });
        return { token, user: { id: u.id, name: u.name, role: u.role } };
      }
    }
    throw new UnauthorizedException('Invalid PIN');
  }
}
