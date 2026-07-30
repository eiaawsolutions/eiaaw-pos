import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { AuthGuard, Roles } from '../common/auth.guard';

@Controller('payments')
export class PaymentsController {
  constructor(private payments: PaymentsService) {}

  @Post('intent')
  @UseGuards(AuthGuard)
  createIntent(@Body() body: { tender: string; amount: number; orderRef: string; idempotencyKey: string }) {
    return this.payments.createIntent(body);
  }

  @Get('status')
  @UseGuards(AuthGuard)
  status(@Query('tender') tender: string, @Query('ref') ref: string) {
    return this.payments.status(tender, ref);
  }

  // Public webhook sink (signature-verified inside)
  @Post('webhook/:provider')
  webhook(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string>,
    @Body() body: any,
  ) {
    return this.payments.webhook(provider, headers, JSON.stringify(body ?? {}));
  }

  @Get('reconciliation')
  @UseGuards(AuthGuard)
  @Roles('OWNER', 'MANAGER')
  reconciliation(@Query('date') date: string) {
    return this.payments.reconciliation(date ?? new Date().toISOString().slice(0, 10));
  }
}
