import { execSync } from 'node:child_process';

/**
 * Runs once per `vitest` invocation, before any test file.
 *
 * Creates the test database if absent and pushes the current Prisma schema
 * into it. Deliberately a *separate* database from development: these tests
 * truncate every table between cases, and pointing them at a developer's
 * working database would silently destroy their seed data.
 */
export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set.\n' +
        'Start the dev stack and point it at the test database, e.g.\n' +
        '  docker compose -f docker-compose.dev.yml up -d\n' +
        '  TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/eiaaw_pos_test npm test',
    );
  }

  const dbName = new URL(url).pathname.slice(1);
  if (!dbName) throw new Error(`TEST_DATABASE_URL has no database name: ${url}`);

  // Guard against the classic footgun: a stray TEST_DATABASE_URL that points at
  // the real database. Everything here is destructive, so refuse anything that
  // is not explicitly a test database.
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run destructive tests against database "${dbName}" — ` + 'the name must contain "test".',
    );
  }

  // Connect to the maintenance database to issue CREATE DATABASE.
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const { Client } = await import('pg');
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) {
      // Identifier cannot be parameterised; dbName is validated above and comes
      // from local configuration, not user input.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[test] created database ${dbName}`);
    }
  } finally {
    await admin.end();
  }

  // `db push` rather than `migrate deploy`: migrations do not exist yet (that
  // is the schema workstream). Swap this over when they land, so the tests
  // exercise the same path production does.
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  console.log(`[test] schema synced to ${dbName}`);
}
