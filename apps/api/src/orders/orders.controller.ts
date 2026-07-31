import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { DiscountAuthorityService } from './discount-authority.service';
import { AuthGuard, Roles } from '../common/auth.guard';
import { CreateOrderDto } from '@eiaaw/shared';

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    private orders: OrdersService,
    private discounts: DiscountAuthorityService,
  ) {}

  /**
   * What the signed-in user may discount unaided. The terminal reads this to
   * know when to raise the approval prompt — it is a UX affordance, not the
   * control: the same rule is enforced again when the order is posted.
   */
  @Get('discount-policy')
  async myDiscountPolicy(@Req() req: any) {
    const policy = await this.discounts.policyFor(req.user.role);
    return policy ?? { role: req.user.role, maxPercentBps: 0, maxAmountSen: 0 };
  }

  @Get('discount-policies')
  @Roles('OWNER', 'MANAGER')
  async discountPolicies() {
    return [...(await this.discounts.policies()).values()];
  }

  @Put('discount-policies/:role')
  @Roles('OWNER')
  setDiscountPolicy(
    @Param('role') role: string,
    @Body() body: { maxPercentBps: number; maxAmountSen: number | null },
  ) {
    return this.discounts.setPolicy({
      role,
      maxPercentBps: body.maxPercentBps,
      maxAmountSen: body.maxAmountSen ?? null,
    });
  }

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
