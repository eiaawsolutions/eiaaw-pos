import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
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
  await prisma.user.upsert({
    where: { email: 'cashier@eiaawsolutions.com' },
    update: {},
    create: {
      name: 'Demo Cashier',
      email: 'cashier@eiaawsolutions.com',
      passwordHash: await bcrypt.hash('Cashier123!', 10),
      pin: await bcrypt.hash('111111', 10),
      role: 'CASHIER',
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
}

main().finally(() => prisma.$disconnect());
