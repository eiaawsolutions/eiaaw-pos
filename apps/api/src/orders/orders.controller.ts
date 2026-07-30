import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { AuthGuard, Roles } from '../common/auth.guard';
import { CreateOrderDto } from '@eiaaw/shared';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private orders: OrdersService) {}

  @Post()
  create(@Body() dto: CreateOrderDto, @Req() req: any) {
    return this.orders.create({ ...dto, staffId: dto.staffId ?? req.user.sub });
  }

  @Get()
  list(@Query('outletId') outletId?: string) {
    return this.orders.list(outletId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }

  @Post(':id/void')
  @Roles('OWNER', 'MANAGER')
  void(@Param('id') id: string, @Body() body: { reason: string }, @Req() req: any) {
    return this.orders.void(id, req.user.sub, body.reason ?? 'unspecified');
  }
}
