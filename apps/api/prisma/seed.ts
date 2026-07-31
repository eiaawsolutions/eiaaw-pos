import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/**
 * Tax codes with a rate already in force, and the discount ceilings each role
 * starts with. Both are configurable data — these are defaults a merchant is
 * expected to revisit, not constants.
 */
async function seedPolicy() {
  const codes: [string, string, number][] = [
    ['SST8', 'Service Tax 8%', 800],
    ['SST6', 'Service Tax 6%', 600],
    ['ZRL', 'Zero-rated', 0],
    ['EXEMPT', 'Exempt', 0],
  ];
  // Dated far enough back that every existing order falls after it, so nothing
  // already sold is left without a rate.
  const inForceSince = new Date('2000-01-01T00:00:00Z');
  for (const [code, name, rateBps] of codes) {
    await prisma.taxCode.upsert({ where: { code }, update: { name }, create: { code, name } });
    const existing = await prisma.taxRate.findFirst({ where: { code, effectiveFrom: inForceSince } });
    if (!existing) await prisma.taxRate.create({ data: { code, rateBps, effectiveFrom: inForceSince } });
  }

  // A cashier can round off a few ringgit to settle a complaint; anything that
  // starts to look like a decision goes to whoever is on duty. Owners are
  // uncapped because someone has to be.
  const policies: [string, number, number | null][] = [
    ['OWNER', 10_000, null],
    ['MANAGER', 5000, 50_000],
    ['CASHIER', 1000, 5000],
    ['KITCHEN', 0, 0],
  ];
  for (const [role, maxPercentBps, maxAmountSen] of policies) {
    await prisma.discountPolicy.upsert({
      where: { role },
      update: {},
      create: { role, maxPercentBps, maxAmountSen },
    });
  }
}

async function main() {
  await seedPolicy();

  const outlet = await prisma.outlet.upsert({
    where: { id: 'outlet-hq' },
    update: {},
    create: { id: 'outlet-hq', name: 'EIAAW Demo Outlet — Putra Heights', profile: 'RETAIL' },
  });

  await prisma.register.upsert({
    where: { id: 'reg-1' },
    update: {},
    create: { id: 'reg-1', name: 'Counter 1', outletId: outlet.id },
  });

  await prisma.user.upsert({
    where: { email: 'admin@eiaawsolutions.com' },
    update: {},
    create: {
      name: 'Amos (Owner)',
      email: 'admin@eiaawsolutions.com',
      passwordHash: await bcrypt.hash('ChangeMe123!', 10),
      pin: await bcrypt.hash('123456', 10),
      role: 'OWNER',
    },
  });
  // Pinned to the outlet: a cashier can only see and move what belongs to the
  // shop they work at. The owner above is left unpinned, which is how one
  // account sees the whole business.
  await prisma.user.upsert({
    where: { email: 'cashier@eiaawsolutions.com' },
    update: { outletId: outlet.id },
    create: {
      name: 'Demo Cashier',
      email: 'cashier@eiaawsolutions.com',
      passwordHash: await bcrypt.hash('Cashier123!', 10),
      pin: await bcrypt.hash('111111', 10),
      role: 'CASHIER',
      outletId: outlet.id,
    },
  });

  const drinks = await prisma.category.upsert({
    where: { id: 'cat-drinks' },
    update: {},
    create: { id: 'cat-drinks', name: 'Drinks', sort: 1, color: '#0ea5e9' },
  });
  const food = await prisma.category.upsert({
    where: { id: 'cat-food' },
    update: {},
    create: { id: 'cat-food', name: 'Food', sort: 2, color: '#f59e0b' },
  });
  const merch = await prisma.category.upsert({
    where: { id: 'cat-merch' },
    update: {},
    create: { id: 'cat-merch', name: 'Merchandise', sort: 3, color: '#8b5cf6' },
  });

  const items: [string, string, string, number, string][] = [
    // name, sku, barcode, price sen, categoryId
    ['Teh Tarik', 'DRK-001', '9551000000017', 450, drinks.id],
    ['Kopi O Ais', 'DRK-002', '9551000000024', 400, drinks.id],
    ['Mineral Water 500ml', 'DRK-003', '9556001010014', 200, drinks.id],
    ['Nasi Lemak Biasa', 'FOD-001', '9551000000109', 850, food.id],
    ['Mee Goreng Mamak', 'FOD-002', '9551000000116', 950, food.id],
    ['Roti Canai', 'FOD-003', '9551000000123', 250, food.id],
    ['Event T-Shirt (L)', 'MRC-001', '9551000000208', 4900, merch.id],
    ['Event Cap', 'MRC-002', '9551000000215', 2900, merch.id],
    ['Tote Bag', 'MRC-003', '9551000000222', 1900, merch.id],
  ];

  for (const [name, sku, barcode, price, categoryId] of items) {
    const existing = await prisma.variant.findUnique({ where: { sku } });
    if (existing) continue;
    const product = await prisma.product.create({
      data: {
        name,
        categoryId,
        taxCode: 'SST8',
        variants: { create: { sku, name, price, barcodes: { create: { code: barcode } } } },
      },
      include: { variants: true },
    });
    await prisma.inventoryLevel.create({
      data: { outletId: outlet.id, variantId: product.variants[0].id, onHand: 200, reorderAt: 20 },
    });
  }

  console.log('Seed complete. Login: admin@eiaawsolutions.com / ChangeMe123! (PIN 123456)');
  console.log('Discount authority: cashier 10%/RM50, manager 50%/RM500, owner unlimited.');
  console.log('Owner PIN 123456 approves an over-limit discount at the terminal.');
}

main().finally(() => prisma.$disconnect());
