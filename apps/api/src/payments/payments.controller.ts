import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsService } from './payments.service';
import { AuthGuard, Roles, resolveOutletScope } from '../common/auth.guard';

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

  /**
   * Public webhook sink, signature-verified inside.
   *
   * The signature is checked against `req.rawBody` — the bytes as they arrived.
   * This used to hand the service `JSON.stringify(body)`, a re-serialisation of
   * what Nest had already parsed: different key order, different whitespace,
   * different unicode escaping, and therefore a different digest than the one
   * the PSP signed. It passed only because the mock's signature was produced
   * from the same mangling.
   */
  @Post('webhook/:provider')
  webhook(
    @Param('provider') provider: string,
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const raw = req.rawBody?.toString('utf8');
    if (raw === undefined) throw new UnauthorizedException('Webhook rejected');
    return this.payments.webhook(provider, headers, raw);
  }

  /**
   * Ledger tender totals for a day.
   *
   * Scoped like every other outlet-scoped read. This was the one that was not:
   * inventory, orders, reports and shifts all resolve the outlet through the
   * caller, and this took a date alone, so a manager pinned to one outlet could
   * read the whole deployment's takings.
   */
  @Get('reconciliation')
  @UseGuards(AuthGuard)
  @Roles('OWNER', 'MANAGER')
  reconciliation(@Query('date') date: string, @Query('outletId') outletId: string, @Req() req: any) {
    return this.payments.reconciliation(
      date ?? new Date().toISOString().slice(0, 10),
      resolveOutletScope(req.user, outletId),
    );
  }
}
