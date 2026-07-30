import { describe, it, expect } from 'vitest';
import { TAX, TAX_RATES, businessDate, signedCashMovement } from './index';

describe('TAX.rate', () => {
  it('knows the codes the catalog is allowed to use', () => {
    expect(TAX.rate('SST8')).toBe(0.08);
    expect(TAX.rate('SST6')).toBe(0.06);
    expect(TAX.rate('ZRL')).toBe(0);
    expect(TAX.rate('EXEMPT')).toBe(0);
  });

  it('refuses an unknown code rather than silently charging zero tax', () => {
    // Defaulting to 0 would under-declare SST on every sale of a
    // mis-configured product, and nothing downstream would notice. Failing
    // the sale is loud, and the fix is a back-office edit.
    expect(() => TAX.rate('SST10')).toThrow(/unknown tax code/i);
    expect(() => TAX.rate('')).toThrow(/unknown tax code/i);
  });

  it('exposes the rate table for back-office display', () => {
    expect(Object.keys(TAX_RATES).sort()).toEqual(['EXEMPT', 'SST6', 'SST8', 'ZRL']);
  });
});

describe('TAX.inclusiveComponent', () => {
  // Malaysian shelf prices are tax-inclusive: the tax is the portion *inside*
  // the price, not something added on top. gross * r / (1 + r).
  it('extracts the tax already inside a tax-inclusive price', () => {
    expect(TAX.inclusiveComponent(1080, 'SST8')).toBe(80); // 1000 net + 80 tax
    expect(TAX.inclusiveComponent(1060, 'SST6')).toBe(60);
  });

  it('is zero for zero-rated and exempt goods', () => {
    expect(TAX.inclusiveComponent(4900, 'ZRL')).toBe(0);
    expect(TAX.inclusiveComponent(4900, 'EXEMPT')).toBe(0);
  });

  it('rounds to whole sen — money has no fractions', () => {
    // 450 * 0.08 / 1.08 = 33.33…
    expect(TAX.inclusiveComponent(450, 'SST8')).toBe(33);
    expect(Number.isInteger(TAX.inclusiveComponent(451, 'SST8'))).toBe(true);
  });

  it('never exceeds the gross it was extracted from', () => {
    for (const gross of [1, 3, 7, 99, 12345]) {
      const tax = TAX.inclusiveComponent(gross, 'SST8');
      expect(tax).toBeGreaterThanOrEqual(0);
      expect(tax).toBeLessThanOrEqual(gross);
    }
  });

  it('handles a refund (negative gross) with a matching negative tax', () => {
    // Otherwise a refund reverses less tax than the sale charged and
    // TAX_PAYABLE drifts by a sen on every return.
    expect(TAX.inclusiveComponent(-1080, 'SST8')).toBe(-80);
    expect(TAX.inclusiveComponent(-450, 'SST8')).toBe(-33);
  });
});

describe('businessDate', () => {
  // The trading day belongs to the outlet, not to whatever timezone the
  // container happens to boot in. A UTC server would otherwise roll the day
  // at 08:00 Malaysian time — mid-morning, halfway through a breakfast rush.
  it('uses the outlet timezone, not the process timezone', () => {
    const justAfterLocalMidnight = new Date('2026-07-30T16:10:00Z'); // 00:10 MYT on the 31st
    expect(businessDate(justAfterLocalMidnight, 'Asia/Kuala_Lumpur')).toBe('2026-07-31');
    expect(businessDate(justAfterLocalMidnight, 'UTC')).toBe('2026-07-30');
  });

  it('keeps a late-night event on the day it started', () => {
    const oneAmLocal = new Date('2026-07-30T17:00:00Z'); // 01:00 MYT on the 31st
    expect(businessDate(oneAmLocal, 'Asia/Kuala_Lumpur')).toBe('2026-07-31');
  });

  it('formats as YYYY-MM-DD so it sorts lexicographically', () => {
    expect(businessDate(new Date('2026-01-05T04:00:00Z'), 'Asia/Kuala_Lumpur')).toBe('2026-01-05');
  });

  it('rejects a timezone it does not recognise instead of guessing UTC', () => {
    expect(() => businessDate(new Date(), 'Mars/Olympus_Mons')).toThrow();
  });
});

describe('signedCashMovement', () => {
  // The drawer only balances if direction comes from the movement type. A
  // bare `SUM(amount)` over unsigned rows makes a cash drop to the safe
  // *increase* expected cash — the exact opposite of what happened.
  it('adds cash in and float', () => {
    expect(signedCashMovement('CASH_IN', 5000)).toBe(5000);
    expect(signedCashMovement('FLOAT', 20000)).toBe(20000);
  });

  it('subtracts cash out and drops to the safe', () => {
    expect(signedCashMovement('CASH_OUT', 5000)).toBe(-5000);
    expect(signedCashMovement('DROP', 50000)).toBe(-50000);
  });

  it('takes a magnitude, so a negative amount is a caller bug', () => {
    expect(() => signedCashMovement('CASH_OUT', -5000)).toThrow(/positive/i);
  });

  it('allows zero', () => {
    expect(signedCashMovement('CASH_IN', 0)).toBe(0);
  });

  it('rejects an unknown movement type', () => {
    expect(() => signedCashMovement('SKIM', 100)).toThrow(/unknown cash movement type/i);
  });
});
