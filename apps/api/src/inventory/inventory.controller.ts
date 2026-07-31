import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AuthGuard, Roles, requireOutletScope } from '../common/auth.guard';

@Controller('inventory')
@UseGuards(AuthGuard)
export class InventoryController {
  constructor(private inventory: InventoryService) {}

  // Every route resolves the outlet through the caller's own scope. Taking the
  // query parameter at face value let anyone with a token read or move stock at
  // any outlet in the business.
  @Get('levels')
  levels(@Query('outletId') outletId: string, @Req() req: any) {
    return this.inventory.levels(requireOutletScope(req.user, outletId));
  }

  @Get('low-stock')
  lowStock(@Query('outletId') outletId: string, @Req() req: any) {
    return this.inventory.lowStock(requireOutletScope(req.user, outletId));
  }

  @Get('movements')
  movements(@Query('outletId') outletId: string, @Query('variantId') variantId: string, @Req() req: any) {
    return this.inventory.movements(requireOutletScope(req.user, outletId), variantId);
  }

  @Post('adjust')
  @Roles('OWNER', 'MANAGER')
  adjust(
    @Body() body: { outletId: string; variantId: string; qty: number; type?: string; reason?: string },
    @Req() req: any,
  ) {
    return this.inventory.adjust({
      ...body,
      outletId: requireOutletScope(req.user, body?.outletId),
      type: body?.type ?? 'ADJUST',
      userId: req.user.sub,
    });
  }
}
