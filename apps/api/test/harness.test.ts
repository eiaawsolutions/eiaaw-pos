import { describe, it, expect } from 'vitest';
import { prisma } from './setup';

/**
 * Proves the integration harness itself works before any real test depends on
 * it: a live connection, a schema that matches the Prisma models, and
 * truncation actually running between cases. Without this, a harness fault
 * looks like a logic bug in whatever test happens to fail first.
 */
describe('integration harness', () => {
  it('connects to the test database', async () => {
    // ::text — these catalog functions return the Postgres `name` type, which
    // the Prisma client cannot deserialize.
    const [{ db }] = await prisma.$queryRaw<{ db: string }[]>`
      SELECT current_database()::text AS db`;
    expect(db).toMatch(/test/i);
  });

  it('has the schema applied', async () => {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename::text FROM pg_tables WHERE schemaname = 'public'`;
    const names = rows.map((r) => r.tablename);
    // A representative slice across the money, catalog and ingest boundaries.
    expect(names).toEqual(
      expect.arrayContaining(['Order', 'OrderLine', 'Payment', 'LedgerEntry', 'Variant', 'ImportSession']),
    );
  });

  it('starts each test with an empty database', async () => {
    expect(await prisma.outlet.count()).toBe(0);
    await prisma.outlet.create({ data: { id: 'o1', name: 'Leaks into the next test?' } });
    expect(await prisma.outlet.count()).toBe(1);
  });

  it('really did truncate — the previous test wrote a row and it is gone', async () => {
    expect(await prisma.outlet.count()).toBe(0);
  });
});
