import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  list(search?: string) {
    return this.prisma.customer.findMany({
      where: search
        ? {
            OR: [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  create(data: { name: string; phone?: string; email?: string; pdpaConsent?: boolean }) {
    return this.prisma.customer.create({ data });
  }

  async history(id: string) {
    return this.prisma.order.findMany({
      where: { customerId: id },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
