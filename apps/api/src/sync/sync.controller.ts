import { Body, Controller, HttpException, Post, UseGuards } from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';
import { AuthGuard } from '../common/auth.guard';
import { SyncBatchDto, SyncResult } from '@eiaaw/shared';

/**
 * Offline-first sync endpoint. Terminals queue orders locally (IndexedDB
 * outbox) and push them in batches when connectivity returns. Idempotency
 * keys make retries safe; duplicates are acknowledged, not re-posted.
 */
@Controller('sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private orders: OrdersService) {}

  @Post('orders')
  async syncOrders(@Body() batch: SyncBatchDto): Promise<SyncResult> {
    const result: SyncResult = { accepted: [], duplicates: [], failed: [] };
    for (const dto of batch.orders ?? []) {
      try {
        const r = await this.orders.create({ ...dto, offline: true });
        (r.duplicate ? result.duplicates : result.accepted).push(dto.idempotencyKey);
      } catch (e: unknown) {
        result.failed.push({
          key: dto.idempotencyKey,
          reason: e instanceof Error ? e.message : 'unknown',
          permanent: isPermanent(e),
        });
      }
    }
    return result;
  }
}

/**
 * Whether replaying this order would fail the same way forever.
 *
 * The server re-prices offline orders from the catalog, so an order that was
 * priced against a stale cache can be refused on arrival. Retrying that on a
 * ten-second timer never converges — it just hides the sale behind a spinner.
 * A 5xx, or anything that is not an HTTP rejection at all, is the opposite
 * case: the server could not answer, and the next attempt may well succeed.
 */
function isPermanent(e: unknown): boolean {
  if (!(e instanceof HttpException)) return false;
  const status = e.getStatus();
  return status >= 400 && status < 500;
}
