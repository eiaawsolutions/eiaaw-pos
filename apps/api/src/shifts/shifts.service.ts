import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { signedCashMovement } from '@eiaaw/shared';

@Injectable()
export class ShiftsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Open a shift on a register.
   *
   * "One shift open per register" is enforced by the unique index on
   * `activeRegisterId`, not by looking first and then inserting: two cashiers
   * tapping Open at the same moment both see no open shift, both insert, and
   * from then on the register has two current shifts with the drawer's cash
   * landing in whichever one a query happens to return.
   */
  async open(params: { outletId: string; registerId: string; userId: string; openingFloat: number }) {
    if (!Number.isInteger(params.openingFloat) || params.openingFloat < 0) {
      throw new BadRequestException(`Invalid opening float ${params.openingFloat}`);
    }
    try {
      return await this.prisma.shift.create({
        data: {
          outletId: params.outletId,
          registerId: params.registerId,
          openedById: params.userId,
          openingFloat: params.openingFloat,
          activeRegisterId: params.registerId,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('A shift is already open on this register');
      }
      throw e;
    }
  }

  /**
   * Blind cash-up: expected cash computed from the ledger, compared to counted.
   *
   * Every term is scoped to this one shift. The predecessor filtered the ledger
   * on `account = 'TENDER_CASH'` and a timestamp alone, which sweeps in every
   * other register — and every other outlet — that was trading in the same
   * window, and hands the cashier an over/short in the thousands on an ordinary
   * day.
   */
  async close(shiftId: string, closingCount: number, userId: string) {
    if (!Number.isInteger(closingCount) || closingCount < 0) {
      throw new BadRequestException(`Invalid closing count ${closingCount}`);
    }

    return this.prisma.$transaction(async (tx) => {
      // Claim the close before counting anything. A conditional update is also
      // the double-tap guard: the second caller blocks on the row, re-evaluates
      // `closedAt IS NULL` once the first commits, and matches nothing.
      // Releasing the register first also stops new sales attaching to a shift
      // that is being counted.
      const claimed = await tx.shift.updateMany({
        where: { id: shiftId, closedAt: null },
        data: { closedAt: new Date(), activeRegisterId: null },
      });
      if (claimed.count === 0) {
        const shift = await tx.shift.findUnique({ where: { id: shiftId } });
        if (!shift) throw new NotFoundException(`No shift ${shiftId}`);
        throw new BadRequestException('Shift already closed');
      }

      const shift = await tx.shift.findUniqueOrThrow({ where: { id: shiftId } });

      const cashLegs = await tx.ledgerEntry.aggregate({
        where: { account: 'TENDER_CASH', shiftId },
        _sum: { debit: true, credit: true },
      });
      // Movements are stored already signed, so a drop to the safe subtracts.
      const movements = await tx.cashMovement.aggregate({
        where: { shiftId },
        _sum: { amount: true },
      });

      const expectedCash =
        shift.openingFloat +
        (cashLegs._sum.debit ?? 0) -
        (cashLegs._sum.credit ?? 0) +
        (movements._sum.amount ?? 0);
      const overShort = closingCount - expectedCash;

      const closed = await tx.shift.update({
        where: { id: shiftId },
        data: { closingCount, expectedCash, overShort },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: 'SHIFT_CLOSE',
          entity: 'Shift',
          entityId: shiftId,
          detail: { overShort, expectedCash, closingCount },
        },
      });
      return closed;
    });
  }

  /**
   * Record cash entering or leaving the drawer. Stored signed by type: summing
   * unsigned rows at cash-up makes banking RM500 look like the till gained
   * RM500, and leaves the cashier RM1000 short against a drawer that is right.
   */
  async cashMovement(params: {
    shiftId: string;
    userId: string;
    type: string;
    amount: number;
    reason?: string;
  }) {
    let amount: number;
    try {
      amount = signedCashMovement(params.type, params.amount);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const shift = await this.prisma.shift.findUnique({ where: { id: params.shiftId } });
    if (!shift) throw new NotFoundException(`No shift ${params.shiftId}`);
    if (shift.closedAt) throw new BadRequestException('Shift is already closed');

    return this.prisma.cashMovement.create({
      data: {
        shiftId: params.shiftId,
        userId: params.userId,
        type: params.type,
        amount,
        reason: params.reason,
      },
    });
  }

  current(registerId: string) {
    return this.prisma.shift.findUnique({
      where: { activeRegisterId: registerId },
      include: { cashMovements: true, openedBy: { select: { name: true } } },
    });
  }
}
