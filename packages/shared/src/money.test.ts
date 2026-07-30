import { describe, it, expect } from 'vitest';
import { MONEY } from './index';

/**
 * Bank Negara Malaysia's rounding mechanism, applied to the *cash* total only:
 * a bill ending in 1, 2, 6 or 7 sen rounds down; 3, 4, 8 or 9 rounds up.
 * Non-cash tenders are charged to the sen and must not be rounded.
 *
 *   ...0  ->  0      ...5  ->  0
 *   ...1  -> -1      ...6  -> -1
 *   ...2  -> -2      ...7  -> -2
 *   ...3  -> +2      ...8  -> +2
 *   ...4  -> +1      ...9  -> +1
 */
describe('MONEY.cashRounding', () => {
  it.each([
    [100, 0],
    [101, -1],
    [102, -2],
    [103, +2],
    [104, +1],
    [105, 0],
    [106, -1],
    [107, -2],
    [108, +2],
    [109, +1],
  ])('rounds %i sen by %i', (total, expected) => {
    expect(MONEY.cashRounding(total)).toBe(expected);
  });

  it('always lands the rounded total on a multiple of 5 sen', () => {
    for (let sen = 0; sen <= 2000; sen++) {
      const rounded = sen + MONEY.cashRounding(sen);
      expect(rounded % 5, `total ${sen} rounded to ${rounded}`).toBe(0);
    }
  });

  it('never moves a total by more than 2 sen', () => {
    for (let sen = 0; sen <= 2000; sen++) {
      expect(Math.abs(MONEY.cashRounding(sen)), `total ${sen}`).toBeLessThanOrEqual(2);
    }
  });

  it('rounds to the nearest 5 sen, breaking the .5 tie upward', () => {
    for (let sen = 0; sen <= 2000; sen++) {
      const rounded = sen + MONEY.cashRounding(sen);
      const nearest = Math.round(sen / 5) * 5;
      expect(rounded, `total ${sen}`).toBe(nearest);
    }
  });

  // Refunds and returns carry a negative total. The rule is symmetric: a
  // refund of 8 sen settles at 10 sen exactly as a sale of 8 sen does, so the
  // customer is never short-changed by the direction of the transaction.
  describe('negative totals (refunds)', () => {
    it.each([
      [-100, 0],
      [-101, +1],
      [-102, +2],
      [-103, -2],
      [-104, -1],
      [-106, +1],
      [-107, +2],
      [-108, -2],
      [-109, -1],
    ])('rounds %i sen by %i', (total, expected) => {
      expect(MONEY.cashRounding(total)).toBe(expected);
    });

    it('is symmetric with the positive case', () => {
      for (let sen = 0; sen <= 2000; sen++) {
        // `+ 0` normalises -0 to 0 on both sides; at sen === 0 the negation
        // produces -0, which toBe rejects against 0 under Object.is.
        expect(MONEY.cashRounding(-sen) + 0, `total -${sen}`).toBe(-MONEY.cashRounding(sen) + 0);
      }
    });

    it('always lands the rounded total on a multiple of 5 sen', () => {
      for (let sen = 0; sen <= 2000; sen++) {
        const rounded = -sen + MONEY.cashRounding(-sen);
        // Math.abs normalises -0, which `%` produces for negative multiples
        // and which toBe(0) would otherwise reject.
        expect(Math.abs(rounded % 5), `total -${sen} rounded to ${rounded}`).toBe(0);
      }
    });
  });
});

describe('MONEY.fmt', () => {
  it.each([
    [0, 'RM 0.00'],
    [5, 'RM 0.05'],
    [450, 'RM 4.50'],
    [4900, 'RM 49.00'],
    [123456, 'RM 1234.56'],
  ])('formats %i sen as %s', (sen, expected) => {
    expect(MONEY.fmt(sen)).toBe(expected);
  });

  it('always shows exactly two decimal places', () => {
    for (const sen of [1, 10, 100, 1000, 99999]) {
      expect(MONEY.fmt(sen)).toMatch(/^-?RM \d+\.\d{2}$/);
    }
  });

  it('puts the sign before the currency symbol, not between it and the digits', () => {
    // "RM -4.50" reads as a malformed amount on a receipt; "-RM 4.50" is a
    // refund line.
    expect(MONEY.fmt(-450)).toBe('-RM 4.50');
  });
});
