import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { DiscountDemand, DiscountPolicyDto, policyAllows } from '@eiaaw/shared';

/** Roles that can ever approve for someone else. Bounds the PIN search. */
const APPROVER_ROLES = ['OWNER', 'MANAGER'];

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 5 * 60_000;

/**
 * One message for every way an approval can fail.
 *
 * A PIN that does not exist and a PIN belonging to someone without the
 * authority have to be indistinguishable from outside, or the terminal becomes
 * an oracle: try PINs until the wording changes, and you have found a real one.
 */
const REFUSED = 'Discount approval refused — the PIN was not accepted for this discount';

@Injectable()
export class DiscountAuthorityService {
  constructor(private prisma: PrismaService) {}

  /**
   * Decide whether this sale's discount may proceed, and on whose authority.
   *
   * Returns the approver's id when someone had to sign for it, null when the
   * seller was within their own limit. Throws when nobody authorised it — the
   * sale does not quietly complete at full price, because the cashier has
   * already told the customer what they are paying.
   */
  async authorise(params: {
    demand: DiscountDemand;
    sellerId: string | null;
    registerId: string | null;
    pin?: string;
  }): Promise<{ approvedById: string | null }> {
    const { demand } = params;
    if (demand.totalSen <= 0 && demand.percentBps <= 0) return { approvedById: null };

    const seller = params.sellerId
      ? await this.prisma.user.findUnique({ where: { id: params.sellerId } })
      : null;
    const policies = await this.policies();

    if (seller && policyAllows(policies.get(seller.role), demand)) {
      return { approvedById: null };
    }

    // Past the seller's own authority: somebody else has to sign for it.
    if (!params.pin) {
      throw new ForbiddenException(
        `A discount of ${demand.totalSen} sen (${(demand.percentBps / 100).toFixed(2)}%) needs approval`,
      );
    }

    await this.assertNotLockedOut(params.registerId);

    const approver = await this.resolveApprover(params.pin, policies, demand);
    await this.prisma.approvalAttempt.create({
      data: {
        action: 'DISCOUNT',
        registerId: params.registerId,
        approverId: approver?.id ?? null,
        success: Boolean(approver),
      },
    });
    if (!approver) throw new ForbiddenException(REFUSED);

    return { approvedById: approver.id };
  }

  /** The configured ceilings, keyed by role. */
  async policies(): Promise<Map<string, DiscountPolicyDto>> {
    const rows = await this.prisma.discountPolicy.findMany();
    return new Map(
      rows.map((r) => [
        r.role,
        { role: r.role, maxPercentBps: r.maxPercentBps, maxAmountSen: r.maxAmountSen },
      ]),
    );
  }

  async policyFor(role: string): Promise<DiscountPolicyDto | undefined> {
    return (await this.policies()).get(role);
  }

  async setPolicy(params: { role: string; maxPercentBps: number; maxAmountSen: number | null }) {
    if (
      !Number.isInteger(params.maxPercentBps) ||
      params.maxPercentBps < 0 ||
      params.maxPercentBps > 10_000
    ) {
      throw new BadRequestException('maxPercentBps must be between 0 and 10000');
    }
    if (params.maxAmountSen !== null && (!Number.isInteger(params.maxAmountSen) || params.maxAmountSen < 0)) {
      throw new BadRequestException('maxAmountSen must be a non-negative integer, or null for no ceiling');
    }
    return this.prisma.discountPolicy.upsert({
      where: { role: params.role },
      update: { maxPercentBps: params.maxPercentBps, maxAmountSen: params.maxAmountSen },
      create: {
        role: params.role,
        maxPercentBps: params.maxPercentBps,
        maxAmountSen: params.maxAmountSen,
      },
    });
  }

  /**
   * Find an active user whose PIN matches and whose role covers this discount.
   *
   * Only approver roles are considered, which keeps this to a handful of bcrypt
   * comparisons instead of one per user in the system — bcrypt is deliberately
   * slow, and an unbounded scan on the hot path of every discounted sale is
   * both a latency problem and something worth pointing a load generator at.
   *
   * Every candidate is compared even after a match, so the work done does not
   * depend on where in the list the right person happens to sit.
   */
  private async resolveApprover(
    pin: string,
    policies: Map<string, DiscountPolicyDto>,
    demand: DiscountDemand,
  ): Promise<{ id: string; role: string } | null> {
    const candidates = await this.prisma.user.findMany({
      where: { active: true, pin: { not: null }, role: { in: APPROVER_ROLES } },
      select: { id: true, role: true, pin: true },
    });

    let approver: { id: string; role: string } | null = null;
    for (const candidate of candidates) {
      const matches = await bcrypt.compare(pin, candidate.pin!);
      if (matches && !approver && policyAllows(policies.get(candidate.role), demand)) {
        approver = { id: candidate.id, role: candidate.role };
      }
    }
    return approver;
  }

  /**
   * Refuse further attempts on a register that has just produced a run of
   * failures. Six digits is a small space and the terminal sits on a shop
   * floor; without this, a PIN is a few thousand requests away.
   *
   * Scoped to the register rather than globally so one till cannot take the
   * whole shop offline — which would turn the lockout itself into the attack.
   */
  private async assertNotLockedOut(registerId: string | null) {
    if (!registerId) return;
    const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
    const failures = await this.prisma.approvalAttempt.count({
      where: { registerId, success: false, createdAt: { gte: since } },
    });
    if (failures >= LOCKOUT_THRESHOLD) {
      throw new ForbiddenException('Too many failed approvals on this register — locked for a few minutes');
    }
  }
}
