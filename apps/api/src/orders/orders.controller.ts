import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { DiscountAuthorityService } from './discount-authority.service';
import { AuthGuard, Roles, requireOutletScope, resolveOutletScope } from '../common/auth.guard';
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
    return this.orders.create({
      ...dto,
      // The seller is whoever holds the token. Taking it from the body let a
      // sale — and any discount on it — be attributed to someone else.
      staffId: req.user.sub,
      outletId: requireOutletScope(req.user, dto?.outletId),
    });
  }

  @Get()
  list(@Query('outletId') outletId: string, @Req() req: any) {
    return this.orders.list(resolveOutletScope(req.user, outletId));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: any) {
    const order = await this.orders.get(id);
    // Not found and not yours read the same from outside, so order ids cannot
    // be walked to discover which belong to another outlet.
    if (!order || (req.user.outletId && order.outletId !== req.user.outletId)) {
      throw new NotFoundException(`No order ${id}`);
    }
    return order;
  }

  @Post(':id/void')
  @Roles('OWNER', 'MANAGER')
  void(@Param('id') id: string, @Body() body: { reason: string }, @Req() req: any) {
    return this.orders.void(id, req.user.sub, body.reason ?? 'unspecified');
  }
}
