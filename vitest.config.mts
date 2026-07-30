import { defineConfig } from 'vitest/config';

// Load the developer's local .env so TEST_DATABASE_URL (and the port overrides
// it depends on) do not have to be repeated on every invocation. CI sets the
// same variables in the job environment, where no .env file exists — hence the
// tolerated failure.
try {
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch {
  /* no .env — CI, or a fresh checkout. Variables come from the environment. */
}

/**
 * Two test projects with very different characteristics:
 *
 *   shared  pure functions (money arithmetic, rounding, business-day maths).
 *           Milliseconds, fully parallel, no I/O.
 *   api     integration tests against a real PostgreSQL. These exist because
 *           the defects worth catching here — ledger balance, concurrent order
 *           numbering, cross-register cash-up — only reproduce against a real
 *           database with real transactions and real unique constraints. A
 *           mocked Prisma would assert nothing.
 *
 * The api project runs single-threaded: several tests deliberately drive
 * concurrency inside one test, and a shared database cannot also be raced
 * between files.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup.ts'],
          // One file at a time: these share a single database and truncate it
          // between cases, so parallel files would wipe each other's fixtures.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Only the code that decides money, access, or the catalog-ingest
      // contract. Controllers are thin pass-throughs and the worker is a
      // scheduler; neither earns a gate.
      include: [
        'apps/api/src/orders/**',
        'apps/api/src/payments/**',
        'apps/api/src/shifts/**',
        'apps/api/src/reports/**',
        'apps/api/src/inventory/**',
        'apps/api/src/auth/**',
        'apps/api/src/ai/**',
        'packages/shared/src/**',
      ],
      exclude: ['**/*.test.ts', '**/dist/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
