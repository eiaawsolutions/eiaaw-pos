import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { TaxService } from './tax.service';
import { AuthGuard, Roles } from '../common/auth.guard';

@Controller('catalog')
@UseGuards(AuthGuard)
export class CatalogController {
  constructor(
    private catalog: CatalogService,
    private tax: TaxService,
  ) {}

  @Get('categories')
  categories() {
    return this.catalog.categories();
  }

  @Get('products')
  products(@Query('search') search?: string) {
    return this.catalog.products(search);
  }

  @Get('scan/:code')
  scan(@Param('code') code: string) {
    return this.catalog.scan(code);
  }

  @Post('products')
  @Roles('OWNER', 'MANAGER')
  create(@Body() body: any) {
    return this.catalog.createProduct(body);
  }

  /** Rates in force now — the terminal's cart preview has to agree with the till. */
  @Get('tax-codes')
  taxCodes() {
    return this.tax.effectiveRates(new Date());
  }

  @Get('tax-codes/:code/history')
  @Roles('OWNER', 'MANAGER')
  taxHistory(@Param('code') code: string) {
    return this.tax.history(code);
  }

  @Post('tax-codes')
  @Roles('OWNER')
  createTaxCode(@Body() body: { code: string; name: string }) {
    return this.tax.createCode({ code: body.code, name: body.name });
  }

  /**
   * Schedule a rate change. Owner-only, and append-only by construction — a
   * rate is dated from when it takes effect, never edited where it stands.
   */
  @Post('tax-rates')
  @Roles('OWNER')
  scheduleRate(
    @Body() body: { code: string; rateBps: number; effectiveFrom: string; note?: string },
    @Req() req: any,
  ) {
    return this.tax.scheduleRate({
      code: body.code,
      rateBps: body.rateBps,
      effectiveFrom: new Date(body.effectiveFrom),
      note: body.note,
      userId: req.user?.sub ?? null,
    });
  }
}
