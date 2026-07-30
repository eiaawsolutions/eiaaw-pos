import { Body, Controller, Post, UseGuards } from '@nestjs/common';
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
      } catch (e: any) {
        result.failed.push({ key: dto.idempotencyKey, reason: e?.message ?? 'unknown' });
      }
    }
    return result;
  }
}
