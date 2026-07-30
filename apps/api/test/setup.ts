import { beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Per-file test database lifecycle.
 *
 * Truncation rather than transaction-rollback isolation: several of the tests
 * that matter here (concurrent order numbering, the ledger balance invariant)
 * run genuinely concurrent writes, which cannot share one outer transaction.
 * TRUNCATE ... CASCADE across every table is a few milliseconds on a dataset
 * this size and keeps each test honest about what it actually wrote.
 */
const url = process.env.TEST_DATABASE_URL!;

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

/**
 * Every table Prisma manages, discovered once so new models are covered
 * automatically as the schema grows.
 *
 * Memoised on the *promise* rather than the resolved value: awaiting first and
 * assigning after leaves a window where two concurrent callers both miss the
 * cache and both query. Caching the promise makes the query happen once.
 */
let tablesPromise: Promise<string[]> | null = null;

function tableNames(): Promise<string[]> {
  tablesPromise ??= (async () => {
    // ::text is required — pg_tables.tablename is the Postgres `name` type,
    // which the Prisma client cannot deserialize.
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename::text FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma\\_%'`;
    return rows.map((r) => `"public"."${r.tablename}"`);
  })();
  return tablesPromise;
}

export async function resetDatabase() {
  const names = await tableNames();
  if (!names.length) return;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names.join(', ')} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});
