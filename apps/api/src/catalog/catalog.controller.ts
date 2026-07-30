import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { AuthGuard, Roles } from '../common/auth.guard';

@Controller('catalog')
@UseGuards(AuthGuard)
export class CatalogController {
  constructor(private catalog: CatalogService) {}

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
}
