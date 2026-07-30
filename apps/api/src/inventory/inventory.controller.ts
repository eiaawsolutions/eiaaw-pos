import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AuthGuard, Roles } from '../common/auth.guard';

@Controller('inventory')
@UseGuards(AuthGuard)
export class InventoryController {
  constructor(private inventory: InventoryService) {}

  @Get('levels')
  levels(@Query('outletId') outletId: string) {
    return this.inventory.levels(outletId);
  }

  @Get('low-stock')
  lowStock(@Query('outletId') outletId: string) {
    return this.inventory.lowStock(outletId);
  }

  @Get('movements')
  movements(@Query('outletId') outletId: string, @Query('variantId') variantId?: string) {
    return this.inventory.movements(outletId, variantId);
  }

  @Post('adjust')
  @Roles('OWNER', 'MANAGER')
  adjust(@Body() body: { outletId: string; variantId: string; qty: number; type?: string; reason?: string }) {
    return this.inventory.adjust({ ...body, type: body.type ?? 'ADJUST' });
  }
}
