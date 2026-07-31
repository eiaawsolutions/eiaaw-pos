import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaxCodeRate } from '@eiaaw/shared';

/** 1000%. Past this it is a data-entry accident, not a tax policy. */
const MAX_RATE_BPS = 100_000;

/**
 * The rate in force for a tax code at a given moment.
 *
 * Rates used to be a frozen table compiled into the shared package, which meant
 * a statutory change was a deploy and, worse, a retroactive one: the new number
 * would have applied to every historical order the moment it shipped. They are
 * effective-dated rows now, so the system holds the old rate and the new one at
 * the same time and knows where the boundary falls. What a past sale was
 * charged stays on the order line regardless; this decides what a sale
 * happening *now* is charged.
 */
@Injectable()
export class TaxService {
  constructor(private prisma: PrismaService) {}

  /**
   * Rate in basis points for `code` at `at`.
   *
   * Refuses rather than defaulting to zero when nothing is in force. Silent
   * zero-rating under-declares SST on every sale of that item and leaves
   * nothing behind to find it by — the same reason the old compiled table threw
   * on an unrecognised code.
   */
  async rateFor(code: string, at: Date): Promise<number> {
    const rate = await this.prisma.taxRate.findFirst({
      where: { code, effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!rate) {
      throw new BadRequestException(
        `No rate in force for tax code "${code}" at ${at.toISOString()} — set one in the back office`,
      );
    }
    return rate.rateBps;
  }

  /**
   * Rates for several codes at once, as a map. One query per sale rather than
   * one per line: a ten-line basket of the same code should not be ten reads.
   */
  async ratesFor(codes: string[], at: Date): Promise<Map<string, number>> {
    const unique = [...new Set(codes)];
    const rows = await this.prisma.taxRate.findMany({
      where: { code: { in: unique }, effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });

    const resolved = new Map<string, number>();
    // Rows arrive newest-first, so the first sighting of each code wins.
    for (const row of rows) if (!resolved.has(row.code)) resolved.set(row.code, row.rateBps);

    const missing = unique.filter((c) => !resolved.has(c));
    if (missing.length) {
      throw new BadRequestException(
        `No rate in force for tax code${missing.length > 1 ? 's' : ''} ${missing
          .map((c) => `"${c}"`)
          .join(', ')} — set one in the back office`,
      );
    }
    return resolved;
  }

  /** Active codes with the rate currently in force, for the terminal's cart preview. */
  async effectiveRates(at: Date): Promise<TaxCodeRate[]> {
    const codes = await this.prisma.taxCode.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
    });
    const rows = await this.prisma.taxRate.findMany({
      where: { code: { in: codes.map((c) => c.code) }, effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
    });

    const resolved = new Map<string, number>();
    for (const row of rows) if (!resolved.has(row.code)) resolved.set(row.code, row.rateBps);

    // A code with no rate yet in force is not sellable, so it is not offered.
    return codes
      .filter((c) => resolved.has(c.code))
      .map((c) => ({ code: c.code, name: c.name, rateBps: resolved.get(c.code)! }));
  }

  /** The full rate history for a code — what changed, when, and on whose authority. */
  history(code: string) {
    return this.prisma.taxRate.findMany({ where: { code }, orderBy: { effectiveFrom: 'desc' } });
  }

  /**
   * Schedule a rate. Append-only: a new row for a new effective date, never an
   * edit to an existing one. Editing would silently restate what past orders
   * were charged, and those orders are what the merchant filed their SST return
   * against.
   */
  async scheduleRate(params: {
    code: string;
    rateBps: number;
    effectiveFrom: Date;
    note?: string;
    userId: string | null;
  }) {
    if (!Number.isInteger(params.rateBps) || params.rateBps < 0 || params.rateBps > MAX_RATE_BPS) {
      throw new BadRequestException(`Invalid tax rate ${params.rateBps} bps`);
    }
    if (Number.isNaN(params.effectiveFrom.getTime())) {
      throw new BadRequestException('Invalid effective date');
    }

    const code = await this.prisma.taxCode.findUnique({ where: { code: params.code } });
    if (!code) throw new NotFoundException(`Unknown tax code "${params.code}"`);

    try {
      return await this.prisma.taxRate.create({
        data: {
          code: params.code,
          rateBps: params.rateBps,
          effectiveFrom: params.effectiveFrom,
          note: params.note,
          createdById: params.userId,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException(
          `A rate for "${params.code}" already starts at ${params.effectiveFrom.toISOString()} — ` +
            'rates are append-only, so pick a different date rather than restating that one',
        );
      }
      throw e;
    }
  }

  /** Create a code. Rates are scheduled separately; a code with none is not sellable. */
  async createCode(params: { code: string; name: string }) {
    if (!/^[A-Z0-9_]{2,16}$/.test(params.code)) {
      throw new BadRequestException('Tax code must be 2-16 characters of A-Z, 0-9 or underscore');
    }
    try {
      return await this.prisma.taxCode.create({ data: { code: params.code, name: params.name } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException(`Tax code "${params.code}" already exists`);
      }
      throw e;
    }
  }
}
