import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardStats } from '@eiaaw/shared';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  /** Live dashboard payload — powers the interactive back-office dashboard */
  async dashboard(outletId?: string): Promise<DashboardStats> {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(dayStart);
    weekStart.setDate(weekStart.getDate() - 13);
    const where = { status: 'COMPLETED', createdAt: { gte: dayStart }, ...(outletId ? { outletId } : {}) };

    const [agg, tenders, hourly, top, byDay] = await Promise.all([
      this.prisma.order.aggregate({ where, _sum: { total: true }, _count: true }),
      this.prisma.payment.groupBy({
        by: ['tender'],
        where: { createdAt: { gte: dayStart }, status: 'CAPTURED', order: { status: 'COMPLETED' } },
        _sum: { amount: true },
      }),
      this.prisma.$queryRaw<{ hour: Date; sales: bigint; orders: bigint }[]>`
        SELECT date_trunc('hour', "createdAt") AS hour, SUM(total)::bigint AS sales, COUNT(*)::bigint AS orders
        FROM "Order" WHERE status = 'COMPLETED' AND "createdAt" >= ${dayStart}
        GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ name: string; qty: bigint; sales: bigint }[]>`
        SELECT ol.name, SUM(ol.qty)::bigint AS qty, SUM(ol.total)::bigint AS sales
        FROM "OrderLine" ol JOIN "Order" o ON o.id = ol."orderId"
        WHERE o.status = 'COMPLETED' AND o."createdAt" >= ${dayStart}
        GROUP BY ol.name ORDER BY sales DESC LIMIT 10`,
      this.prisma.$queryRaw<{ date: Date; sales: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS date, SUM(total)::bigint AS sales
        FROM "Order" WHERE status = 'COMPLETED' AND "createdAt" >= ${weekStart}
        GROUP BY 1 ORDER BY 1`,
    ]);

    const todaySales = agg._sum.total ?? 0;
    const todayOrders = agg._count;
    return {
      todaySales,
      todayOrders,
      avgTicket: todayOrders ? Math.round(todaySales / todayOrders) : 0,
      tenderMix: tenders.map((t) => ({ tender: t.tender, amount: t._sum.amount ?? 0 })),
      hourlySales: hourly.map((h) => ({
        hour: new Date(h.hour).toISOString(),
        sales: Number(h.sales),
        orders: Number(h.orders),
      })),
      topProducts: top.map((t) => ({ name: t.name, qty: Number(t.qty), sales: Number(t.sales) })),
      salesByDay: byDay.map((d) => ({
        date: new Date(d.date).toISOString().slice(0, 10),
        sales: Number(d.sales),
      })),
    };
  }

  /** X/Z-style daily summary for an outlet */
  async daily(outletId: string, date: string) {
    const start = new Date(date);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const where = { outletId, status: 'COMPLETED', createdAt: { gte: start, lt: end } };
    const [orders, tax, voids, refundsLegs] = await Promise.all([
      this.prisma.order.aggregate({
        where,
        _sum: { total: true, discountTotal: true, taxTotal: true },
        _count: true,
      }),
      this.prisma.order.aggregate({ where, _sum: { taxTotal: true } }),
      this.prisma.order.count({ where: { outletId, status: 'VOIDED', createdAt: { gte: start, lt: end } } }),
      this.prisma.ledgerEntry.aggregate({
        where: { account: 'REFUNDS', createdAt: { gte: start, lt: end } },
        _sum: { debit: true },
      }),
    ]);
    return {
      date,
      outletId,
      grossSales: orders._sum.total ?? 0,
      discounts: orders._sum.discountTotal ?? 0,
      sstCollected: tax._sum.taxTotal ?? 0,
      orderCount: orders._count,
      voidCount: voids,
      refunds: refundsLegs._sum.debit ?? 0,
    };
  }

  /** Sales by staff — commission & performance view */
  staffSales(date: string) {
    const start = new Date(date);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return this.prisma.order.groupBy({
      by: ['staffId'],
      where: { status: 'COMPLETED', createdAt: { gte: start, lt: end } },
      _sum: { total: true },
      _count: true,
    });
  }
}
