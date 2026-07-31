import { describe, it, expect } from 'vitest';
import { TAX, businessDate, discountDemand, policyAllows, signedCashMovement } from './index';

describe('TAX.inclusiveComponent', () => {
  // Malaysian shelf prices are tax-inclusive: the tax is the portion *inside*
  // the price, not something added on top. gross * r / (1 + r), which in basis
  // points is gross * bps / (10000 + bps) — integer throughout, so nothing
  // depends on a float landing where it ought.
  it('extracts the tax already inside a tax-inclusive price', () => {
    expect(TAX.inclusiveComponent(1080, 800)).toBe(80); // 1000 net + 80 tax
    expect(TAX.inclusiveComponent(1060, 600)).toBe(60);
  });

  it('is zero at a zero rate', () => {
    expect(TAX.inclusiveComponent(4900, 0)).toBe(0);
  });

  it('rounds to whole sen — money has no fractions', () => {
    // 450 * 800 / 10800 = 33.33…
    expect(TAX.inclusiveComponent(450, 800)).toBe(33);
    expect(Number.isInteger(TAX.inclusiveComponent(451, 800))).toBe(true);
  });

  it('never exceeds the gross it was extracted from', () => {
    for (const gross of [1, 3, 7, 99, 12345]) {
      const tax = TAX.inclusiveComponent(gross, 800);
      expect(tax).toBeGreaterThanOrEqual(0);
      expect(tax).toBeLessThanOrEqual(gross);
    }
  });

  it('handles a refund (negative gross) with a matching negative tax', () => {
    // Otherwise a refund reverses less tax than the sale charged and
    // TAX_PAYABLE drifts by a sen on every return.
    expect(TAX.inclusiveComponent(-1080, 800)).toBe(-80);
    expect(TAX.inclusiveComponent(-450, 800)).toBe(-33);
  });

  it('refuses a rate that is not a sane basis-point integer', () => {
    // A misconfigured rate must not silently become "no tax" or a fraction of
    // a sen that compounds across a day's takings.
    expect(() => TAX.inclusiveComponent(1000, 8)).not.toThrow(); // 0.08% is odd but legal
    expect(() => TAX.inclusiveComponent(1000, -100)).toThrow(/rate/i);
    expect(() => TAX.inclusiveComponent(1000, 8.5)).toThrow(/rate/i);
    expect(() => TAX.inclusiveComponent(1000, 100_001)).toThrow(/rate/i);
  });

  it('survives a rate change without restating the old one', () => {
    // The 6% -> 8% service tax move: the same gross carries different tax
    // depending on which rate was in force, and both must be expressible.
    expect(TAX.inclusiveComponent(10_600, 600)).toBe(600);
    expect(TAX.inclusiveComponent(10_800, 800)).toBe(800);
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

describe('discountDemand', () => {
  // How much authority a sale is asking for. Shared so the terminal knows when
  // to raise the approval prompt and the server decides on the same arithmetic
  // — two implementations of this rule would disagree, and the one that
  // mattered would be the lenient one.
  it('is nothing when nothing is discounted', () => {
    expect(discountDemand([{ gross: 1000, discount: 0 }], 0)).toEqual({ percentBps: 0, totalSen: 0 });
  });

  it('measures a line discount against that line', () => {
    expect(discountDemand([{ gross: 1000, discount: 100 }], 0)).toEqual({
      percentBps: 1000, // 10%
      totalSen: 100,
    });
  });

  it('takes the steepest line, not the average', () => {
    // Half off one item is a 50% decision, however large the rest of the cart.
    const demand = discountDemand(
      [
        { gross: 1000, discount: 500 },
        { gross: 9000, discount: 0 },
      ],
      0,
    );
    expect(demand.percentBps).toBe(5000);
    expect(demand.totalSen).toBe(500);
  });

  it('measures a cart discount against the whole cart', () => {
    expect(discountDemand([{ gross: 1000, discount: 0 }], 100)).toEqual({
      percentBps: 1000,
      totalSen: 100,
    });
  });

  it('counts line and cart discounts together against the cart', () => {
    // 50% off one line then 10% off everything is not a 10% decision.
    const demand = discountDemand([{ gross: 1000, discount: 500 }], 100);
    expect(demand.totalSen).toBe(600);
    expect(demand.percentBps).toBe(6000); // 600 of 1000
  });

  it('treats any discount on a zero-priced line as total', () => {
    expect(discountDemand([{ gross: 0, discount: 50 }], 0).percentBps).toBe(10_000);
  });

  it('does not divide by zero on an empty or free cart', () => {
    expect(discountDemand([], 0)).toEqual({ percentBps: 0, totalSen: 0 });
    expect(discountDemand([{ gross: 0, discount: 0 }], 0)).toEqual({ percentBps: 0, totalSen: 0 });
  });
});

describe('policyAllows', () => {
  const cashier = { role: 'CASHIER', maxPercentBps: 1000, maxAmountSen: 5000 };
  const owner = { role: 'OWNER', maxPercentBps: 10_000, maxAmountSen: null };

  it('permits a discount inside both ceilings', () => {
    expect(policyAllows(cashier, { percentBps: 1000, totalSen: 5000 })).toBe(true);
  });

  it('refuses one that is too steep even when the amount is small', () => {
    expect(policyAllows(cashier, { percentBps: 5000, totalSen: 100 })).toBe(false);
  });

  it('refuses one that is too large even when the percentage is modest', () => {
    // 5% of a RM2,000 basket is still RM100 out of the till.
    expect(policyAllows(cashier, { percentBps: 500, totalSen: 10_000 })).toBe(false);
  });

  it('treats a null amount ceiling as no ceiling', () => {
    expect(policyAllows(owner, { percentBps: 10_000, totalSen: 9_999_999 })).toBe(true);
  });

  it('always permits no discount at all, even for a role with no authority', () => {
    const kitchen = { role: 'KITCHEN', maxPercentBps: 0, maxAmountSen: 0 };
    expect(policyAllows(kitchen, { percentBps: 0, totalSen: 0 })).toBe(true);
    expect(policyAllows(kitchen, { percentBps: 1, totalSen: 1 })).toBe(false);
  });

  it('refuses when there is no policy for the role at all', () => {
    // An unrecognised role must not inherit someone else's authority.
    expect(policyAllows(undefined, { percentBps: 1, totalSen: 1 })).toBe(false);
    expect(policyAllows(undefined, { percentBps: 0, totalSen: 0 })).toBe(true);
  });
});
