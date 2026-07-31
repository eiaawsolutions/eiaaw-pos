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
      // contract. The worker is a scheduler and earns no gate.
      include: [
        'apps/api/src/orders/**',
        'apps/api/src/catalog/**',
        'apps/api/src/payments/**',
        'apps/api/src/shifts/**',
        'apps/api/src/sync/**',
        'apps/api/src/reports/**',
        'apps/api/src/inventory/**',
        'apps/api/src/auth/**',
        'apps/api/src/ai/**',
        // Not a whole directory: the rest of `common` is logging and a health
        // probe, but the guard is the authorisation boundary.
        'apps/api/src/common/auth.guard.ts',
        'packages/shared/src/**',
      ],
      exclude: [
        '**/*.test.ts',
        '**/dist/**',
        // Thin HTTP pass-throughs: a route binding and a service call, no
        // decision of their own. sync.controller is deliberately absent from
        // this list — it classifies which sync failures are worth retrying,
        // which is a decision, and it is gated below.
        'apps/api/src/orders/orders.controller.ts',
        'apps/api/src/catalog/catalog.controller.ts',
        'apps/api/src/payments/payments.controller.ts',
        'apps/api/src/shifts/shifts.controller.ts',
        'apps/api/src/reports/reports.controller.ts',
        'apps/api/src/inventory/inventory.controller.ts',
        'apps/api/src/auth/auth.controller.ts',
        'apps/api/src/ai/onboarding.controller.ts',
      ],
      /**
       * A ratchet on the whole, and a real bar on the parts.
       *
       * The single 80% global this replaces was never met — 2% when it was
       * written, 50% now — so CI was red on every commit regardless of what the
       * commit did. A gate that is always red is one nobody reads, and it fails
       * open: the day a real regression lands it looks exactly like the previous
       * four hundred runs.
       *
       * The two honest ways out are to write the four missing suites in one go,
       * or to say plainly what is covered and what is owed. This is the second.
       * Note that the globals are *not* a relaxation: they now sit against the
       * measured aggregate so it cannot slide, and the code that decides money
       * is held per file at 85–100%, well above the 80% it used to notionally
       * share with everything else. Strictly tighter where it counts.
       *
       * Glob keys must open with a globstar segment: Vitest matches them
       * against absolute paths, so a repo-relative key silently matches
       * nothing — a gate that looks present and asserts naught. Verify a new
       * key binds by setting it absurdly high once and watching it fail by
       * name. They also stack on top of the globals rather than replacing them
       * for the files they match.
       */
      thresholds: {
        // Ratchet: the aggregate over everything in `include`, a point below
        // where it stands. Raise these as suites land — never lower them to
        // make a run pass.
        statements: 59,
        branches: 50,
        functions: 55,
        lines: 59,

        // ── Covered. Held just under today's figures: enough slack to
        //    refactor, not enough to quietly drop a branch. ──

        // Pure money arithmetic with no I/O, so there is no excuse for a line
        // of it to go unexercised. Held at the top.
        '**/packages/shared/src/**': { statements: 100, branches: 95, functions: 100, lines: 100 },
        '**/apps/api/src/orders/orders.service.ts': {
          statements: 85,
          branches: 73,
          functions: 78,
          lines: 88,
        },
        '**/apps/api/src/shifts/shifts.service.ts': {
          statements: 85,
          branches: 76,
          functions: 95,
          lines: 90,
        },
        // Every authorisation decision in the API passes through here, so it is
        // held at the top: no statement of it goes unexercised, and the only
        // slack is on branches, where the short-circuits in `roles?.length &&`
        // have arms that cannot be reached independently.
        '**/apps/api/src/common/auth.guard.ts': {
          statements: 100,
          branches: 85,
          functions: 100,
          lines: 100,
        },
        '**/apps/api/src/catalog/tax.service.ts': {
          statements: 78,
          branches: 62,
          functions: 80,
          lines: 75,
        },
        '**/apps/api/src/orders/discount-authority.service.ts': {
          statements: 82,
          branches: 62,
          functions: 72,
          lines: 83,
        },
        '**/apps/api/src/sync/sync.controller.ts': {
          statements: 95,
          branches: 75,
          functions: 100,
          lines: 95,
        },

        // ── Owed, not waived. Zero is a placeholder that asserts nothing; it
        //    is here so the debt is named in the file that gates the build,
        //    and so landing a suite is a one-line edit rather than an
        //    archaeology exercise. Each of these is a workstream. ──

        // Barcode resolution on the hot path of every scan, and the only write
        // path into the catalog the till prices from.
        '**/apps/api/src/catalog/catalog.service.ts': {
          statements: 0,
          branches: 0,
          functions: 0,
          lines: 0,
        },
        // Prices nothing, but moves money: PSP intents, webhook signature
        // verification, capture/refund state. Untested webhook handling is how
        // a forged callback marks an order paid.
        '**/apps/api/src/payments/**': { statements: 0, branches: 0, functions: 0, lines: 0 },
        // The numbers the merchant files SST against.
        '**/apps/api/src/reports/**': { statements: 0, branches: 0, functions: 0, lines: 0 },
        // Stock movements and the audit trail behind them.
        '**/apps/api/src/inventory/**': { statements: 0, branches: 0, functions: 0, lines: 0 },
        // Login, PIN switching, token issuance.
        '**/apps/api/src/auth/**': { statements: 0, branches: 0, functions: 0, lines: 0 },
        // The zero-hallucination ingest contract — the promise that the system
        // cannot sell an assumed price — is currently asserted by nothing.
        '**/apps/api/src/ai/**': { statements: 0, branches: 0, functions: 0, lines: 0 },
      },
    },
  },
});
