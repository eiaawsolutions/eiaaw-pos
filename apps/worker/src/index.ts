/**
 * EIAAW POS worker — background jobs kept off the API hot path so terminals
 * stay fast during high-volume events.
 *
 *  1. MyInvois e-invoice submitter (stub → real LHDN API in v1.0)
 *  2. Hourly sales rollups (pre-aggregation that keeps dashboards fast)
 *
 * Uses DB polling so the scaffold runs with zero extra infra; when REDIS_URL
 * is set, swap the pollers for BullMQ queues (deps already included).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
const EINVOICE_INTERVAL_MS = 30_000;
const ROLLUP_INTERVAL_MS = 60_000;

async function submitQueuedEInvoices() {
  const queued = await prisma.eInvoice.findMany({ where: { status: 'QUEUED' }, take: 50 });
  for (const inv of queued) {
    // v1.0: build UBL 2.1 JSON, sign, submit to LHDN MyInvois API, store UUID.
    // Scaffold: mark as SUBMITTED with a placeholder so the pipeline is testable.
    await prisma.eInvoice.update({
      where: { id: inv.id },
      data: { status: 'SUBMITTED', submittedAt: new Date(), uuid: `PENDING-LHDN-${inv.id.slice(-8)}` },
    });
  }
  if (queued.length) console.log(`[einvoice] processed ${queued.length}`);
}

async function rollupHourly() {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000); // re-aggregate last 2h
  const rows = await prisma.$queryRaw<{ outletId: string; bucket: Date; orders: bigint; sales: bigint }[]>`
    SELECT "outletId", date_trunc('hour', "createdAt") AS bucket,
           COUNT(*)::bigint AS orders, SUM(total)::bigint AS sales
    FROM "Order" WHERE status = 'COMPLETED' AND "createdAt" >= ${since}
    GROUP BY 1, 2`;
  for (const r of rows) {
    await prisma.salesRollupHourly.upsert({
      where: { outletId_bucket: { outletId: r.outletId, bucket: r.bucket } },
      update: { orders: Number(r.orders), sales: Number(r.sales) },
      create: { outletId: r.outletId, bucket: r.bucket, orders: Number(r.orders), sales: Number(r.sales) },
    });
  }
}

async function main() {
  console.log('EIAAW POS worker started');
  setInterval(
    () => submitQueuedEInvoices().catch((e) => console.error('[einvoice]', e)),
    EINVOICE_INTERVAL_MS,
  );
  setInterval(() => rollupHourly().catch((e) => console.error('[rollup]', e)), ROLLUP_INTERVAL_MS);
}

main();
