import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ShiftsService {
  constructor(private prisma: PrismaService) {}

  async open(params: { outletId: string; registerId: string; userId: string; openingFloat: number }) {
    const existing = await this.prisma.shift.findFirst({
      where: { registerId: params.registerId, closedAt: null },
    });
    if (existing) throw new BadRequestException('A shift is already open on this register');
    return this.prisma.shift.create({
      data: {
        outletId: params.outletId,
        registerId: params.registerId,
        openedById: params.userId,
        openingFloat: params.openingFloat,
      },
    });
  }

  /** Blind cash-up: expected cash computed from ledger, compared to counted */
  async close(shiftId: string, closingCount: number, userId: string) {
    const shift = await this.prisma.shift.findUniqueOrThrow({ where: { id: shiftId } });
    if (shift.closedAt) throw new BadRequestException('Shift already closed');

    const cashLegs = await this.prisma.ledgerEntry.aggregate({
      where: { account: 'TENDER_CASH', createdAt: { gte: shift.openedAt } },
      _sum: { debit: true, credit: true },
    });
    const movements = await this.prisma.cashMovement.aggregate({
      where: { shiftId },
      _sum: { amount: true },
    });
    const expectedCash =
      shift.openingFloat +
      (cashLegs._sum.debit ?? 0) -
      (cashLegs._sum.credit ?? 0) +
      (movements._sum.amount ?? 0);
    const overShort = closingCount - expectedCash;

    const closed = await this.prisma.shift.update({
      where: { id: shiftId },
      data: { closedAt: new Date(), closingCount, expectedCash, overShort },
    });
    await this.prisma.auditLog.create({
      data: { userId, action: 'SHIFT_CLOSE', entity: 'Shift', entityId: shiftId, detail: { overShort } },
    });
    return closed;
  }

  cashMovement(params: { shiftId: string; userId: string; type: string; amount: number; reason?: string }) {
    return this.prisma.cashMovement.create({ data: params });
  }

  current(registerId: string) {
    return this.prisma.shift.findFirst({
      where: { registerId, closedAt: null },
      include: { cashMovements: true, openedBy: { select: { name: true } } },
    });
  }
}
