import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CatalogService {
  constructor(private prisma: PrismaService) {}

  categories() {
    return this.prisma.category.findMany({ orderBy: { sort: 'asc' } });
  }

  products(search?: string) {
    return this.prisma.product.findMany({
      where: {
        active: true,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { variants: { some: { sku: { contains: search, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      include: { variants: { where: { active: true }, include: { barcodes: true } }, category: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Barcode scan resolution — the hot path at the terminal */
  async scan(code: string) {
    const barcode = await this.prisma.barcode.findUnique({
      where: { code },
      include: { variant: { include: { product: true } } },
    });
    if (barcode) return barcode.variant;
    const bySku = await this.prisma.variant.findUnique({
      where: { sku: code },
      include: { product: true },
    });
    if (!bySku) throw new NotFoundException(`No product for code ${code}`);
    return bySku;
  }

  async createProduct(data: {
    name: string;
    categoryId?: string;
    taxCode?: string;
    variants: { sku: string; name: string; price: number; cost?: number; barcodes?: string[] }[];
  }) {
    return this.prisma.product.create({
      data: {
        name: data.name,
        categoryId: data.categoryId,
        taxCode: data.taxCode ?? 'SST8',
        variants: {
          create: data.variants.map((v) => ({
            sku: v.sku,
            name: v.name,
            price: v.price,
            cost: v.cost ?? 0,
            barcodes: { create: (v.barcodes ?? []).map((code) => ({ code })) },
          })),
        },
      },
      include: { variants: { include: { barcodes: true } } },
    });
  }
}
