import { randomUUID } from 'node:crypto';
import { prisma } from './setup';
import type { CreateOrderDto } from '@eiaaw/shared';
import { OrdersService } from '../src/orders/orders.service';
import { TaxService } from '../src/catalog/tax.service';
import { DiscountAuthorityService } from '../src/orders/discount-authority.service';

/**
 * An OrdersService with its real collaborators. Stubbing the tax resolver or
 * the authority check here would mean the money path under test is not the one
 * that runs in production, which is the whole point of an integration suite.
 */
export function ordersService() {
  return new OrdersService(
    prisma as never,
    new TaxService(prisma as never) as never,
    new DiscountAuthorityService(prisma as never) as never,
  );
}

/** Tax codes and discount policies, which almost every fixture depends on. */
export async function seedPolicyDefaults() {
  await seedTaxCodes();
  await seedDiscountPolicies();
}

/**
 * Fixture builders for the integration suite.
 *
 * Every helper takes explicit ids where a test needs to refer back to the row,
 * and generates one otherwise — so a test only spells out the parts of the
 * world it actually reasons about.
 */

/**
 * The statutory tax codes, with a rate already in force. Products carry a
 * foreign key to these, so almost every fixture needs them present first.
 */
export async function seedTaxCodes() {
  const codes = [
    { code: 'SST8', name: 'Service Tax 8%', rateBps: 800 },
    { code: 'SST6', name: 'Service Tax 6%', rateBps: 600 },
    { code: 'ZRL', name: 'Zero-rated', rateBps: 0 },
    { code: 'EXEMPT', name: 'Exempt', rateBps: 0 },
  ];
  const long_ago = new Date('2000-01-01T00:00:00Z');
  for (const c of codes) {
    await prisma.taxCode.create({ data: { code: c.code, name: c.name } });
    await prisma.taxRate.create({
      data: { code: c.code, rateBps: c.rateBps, effectiveFrom: long_ago },
    });
  }
}

/** Default discount authority: what each role may take off a sale unaided. */
export async function seedDiscountPolicies() {
  await prisma.discountPolicy.createMany({
    data: [
      { role: 'OWNER', maxPercentBps: 10_000, maxAmountSen: null },
      { role: 'MANAGER', maxPercentBps: 5000, maxAmountSen: 50_000 },
      { role: 'CASHIER', maxPercentBps: 1000, maxAmountSen: 5000 },
      { role: 'KITCHEN', maxPercentBps: 0, maxAmountSen: 0 },
    ],
  });
}

export async function makeOutlet(
  opts: { id?: string; name?: string; timezone?: string } = {},
): Promise<{ id: string; timezone: string }> {
  const outlet = await prisma.outlet.create({
    data: {
      id: opts.id ?? `outlet-${randomUUID().slice(0, 8)}`,
      name: opts.name ?? 'Test Outlet',
      ...(opts.timezone ? { timezone: opts.timezone } : {}),
    },
  });
  return { id: outlet.id, timezone: outlet.timezone };
}

export async function makeRegister(outletId: string, opts: { id?: string; name?: string } = {}) {
  return prisma.register.create({
    data: {
      id: opts.id ?? `reg-${randomUUID().slice(0, 8)}`,
      name: opts.name ?? 'Counter',
      outletId,
    },
  });
}

export async function makeUser(opts: { id?: string; role?: string; email?: string } = {}) {
  return prisma.user.create({
    data: {
      id: opts.id ?? `user-${randomUUID().slice(0, 8)}`,
      name: 'Test Cashier',
      email: opts.email ?? `${randomUUID().slice(0, 8)}@example.test`,
      passwordHash: 'not-a-real-hash',
      role: opts.role ?? 'CASHIER',
    },
  });
}

/**
 * A sellable product with one variant, stocked at the outlet. Returns the
 * variant, which is what an order line points at.
 */
export async function makeProduct(opts: {
  outletId: string;
  price: number;
  taxCode?: string;
  name?: string;
  active?: boolean;
  onHand?: number;
}) {
  const sku = `SKU-${randomUUID().slice(0, 8)}`;
  const product = await prisma.product.create({
    data: {
      name: opts.name ?? 'Test Item',
      taxCode: opts.taxCode ?? 'SST8',
      variants: {
        create: { sku, name: opts.name ?? 'Test Item', price: opts.price, active: opts.active ?? true },
      },
    },
    include: { variants: true },
  });
  const variant = product.variants[0];
  await prisma.inventoryLevel.create({
    data: { outletId: opts.outletId, variantId: variant.id, onHand: opts.onHand ?? 100 },
  });
  return { product, variant };
}

/**
 * A well-formed order request. Tests override exactly the field under test,
 * which keeps the tampering in each case obvious at a glance.
 */
export function orderDto(opts: {
  outletId: string;
  registerId: string;
  staffId?: string;
  lines: CreateOrderDto['lines'];
  payments?: CreateOrderDto['payments'];
  cartDiscount?: number;
  roundingAdjustment?: number;
  idempotencyKey?: string;
  offline?: boolean;
}): CreateOrderDto {
  return {
    idempotencyKey: opts.idempotencyKey ?? randomUUID(),
    outletId: opts.outletId,
    registerId: opts.registerId,
    staffId: opts.staffId,
    lines: opts.lines,
    cartDiscount: opts.cartDiscount ?? 0,
    roundingAdjustment: opts.roundingAdjustment ?? 0,
    payments: opts.payments ?? [],
    placedAt: new Date().toISOString(),
    offline: opts.offline,
  };
}

/** A cart line as the terminal would send it, with the honest numbers. */
export function line(
  variant: { id: string; sku: string; name: string },
  opts: { qty?: number; unitPrice: number; discount?: number; taxCode?: string; taxAmount?: number },
): CreateOrderDto['lines'][number] {
  return {
    variantId: variant.id,
    name: variant.name,
    sku: variant.sku,
    qty: opts.qty ?? 1,
    unitPrice: opts.unitPrice,
    discount: opts.discount ?? 0,
    taxCode: opts.taxCode ?? 'SST8',
    taxAmount: opts.taxAmount ?? 0,
  };
}

/**
 * Double-entry invariant: within every transaction group, debits equal
 * credits. Any money bug that mis-states one leg shows up here regardless of
 * which code path wrote it, so most tests assert this alongside their subject.
 */
export async function assertLedgerBalanced() {
  const rows = await prisma.$queryRaw<{ txnId: string; debit: bigint; credit: bigint }[]>`
    SELECT "txnId", SUM(debit)::bigint AS debit, SUM(credit)::bigint AS credit
    FROM "LedgerEntry" GROUP BY "txnId" HAVING SUM(debit) <> SUM(credit)`;
  if (rows.length) {
    const detail = rows.map((r) => `  ${r.txnId}: debit ${r.debit} != credit ${r.credit}`).join('\n');
    throw new Error(`Ledger does not balance:\n${detail}`);
  }
}
