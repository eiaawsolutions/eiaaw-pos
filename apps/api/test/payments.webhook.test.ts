import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { prisma } from './setup';
import { PaymentsService } from '../src/payments/payments.service';

const SECRET = 'webhook-test-secret';
const PROVIDER = 'MOCK_DUITNOW';

/**
 * The webhook is the only unauthenticated, money-moving door in the system. A
 * caller who satisfies it can mark an order paid, so the signature is not one
 * check among several — it is the whole boundary.
 */
describe('payments — the webhook sink', () => {
  let payments: PaymentsService;
  const previousSecret = process.env.PSP_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.PSP_WEBHOOK_SECRET = SECRET;
    payments = new PaymentsService(prisma as never);
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.PSP_WEBHOOK_SECRET;
    else process.env.PSP_WEBHOOK_SECRET = previousSecret;
  });

  const sign = (raw: string, secret = SECRET) =>
    createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

  const deliver = (event: Record<string, unknown>, opts: { secret?: string; raw?: string } = {}) => {
    const raw = opts.raw ?? JSON.stringify(event);
    return payments.webhook(PROVIDER, { 'x-signature': sign(raw, opts.secret ?? SECRET) }, raw);
  };

  /** An order with one electronic payment, as a QR sale would leave it. */
  async function pendingPayment(opts: { amount?: number; status?: string; ref?: string } = {}) {
    const outlet = await prisma.outlet.create({ data: { name: 'Webhook Outlet' } });
    const order = await prisma.order.create({
      data: {
        orderNo: `WH-${Math.random().toString(36).slice(2, 8)}`,
        idempotencyKey: `wh-${Math.random().toString(36).slice(2)}`,
        outletId: outlet.id,
        subtotal: opts.amount ?? 5000,
        total: opts.amount ?? 5000,
      },
    });
    return prisma.payment.create({
      data: {
        orderId: order.id,
        tender: 'DUITNOW_QR',
        amount: opts.amount ?? 5000,
        status: opts.status ?? 'PENDING',
        provider: 'MOCK',
        providerRef: opts.ref ?? `mockdn_${Math.random().toString(36).slice(2)}`,
      },
    });
  }

  describe('the signature', () => {
    it('advances a payment when the signature is good', async () => {
      const payment = await pendingPayment();
      const result = await deliver({
        eventId: 'evt-1',
        providerRef: payment.providerRef,
        status: 'CAPTURED',
        amount: payment.amount,
      });

      expect(result).toMatchObject({ ok: true });
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('CAPTURED');
    });

    it('refuses an unsigned delivery', async () => {
      const payment = await pendingPayment();
      await expect(
        payments.webhook(PROVIDER, {}, JSON.stringify({ eventId: 'e', providerRef: payment.providerRef })),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('refuses a signature made with the wrong secret', async () => {
      const payment = await pendingPayment();
      await expect(
        deliver(
          { eventId: 'evt-2', providerRef: payment.providerRef, status: 'CAPTURED' },
          { secret: 'not-the-secret' },
        ),
      ).rejects.toThrow(UnauthorizedException);

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('PENDING');
    });

    it('refuses a body edited after it was signed', async () => {
      // The signature covers the bytes, so changing the amount invalidates it
      // even though the JSON is still well formed.
      const payment = await pendingPayment();
      const signed = JSON.stringify({
        eventId: 'evt-3',
        providerRef: payment.providerRef,
        status: 'CAPTURED',
        amount: 5000,
      });
      const tampered = signed.replace('"amount":5000', '"amount":1');

      await expect(payments.webhook(PROVIDER, { 'x-signature': sign(signed) }, tampered)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('is computed over the bytes as they arrived, not a re-serialisation', async () => {
      // Same object, different bytes: reordered keys and added whitespace. A
      // sink that re-stringified the parsed body would accept this, because it
      // would be hashing its own normalised copy rather than what was signed.
      const payment = await pendingPayment();
      const raw = `{"status":"CAPTURED",  "providerRef":"${payment.providerRef}","eventId":"evt-4"}`;
      const result = await payments.webhook(PROVIDER, { 'x-signature': sign(raw) }, raw);

      expect(result).toMatchObject({ ok: true });
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('CAPTURED');
    });

    it('refuses everything when no secret is configured', async () => {
      // Rather than falling back to a default published in this repository.
      delete process.env.PSP_WEBHOOK_SECRET;
      const payment = await pendingPayment();
      await expect(
        payments.webhook(
          PROVIDER,
          { 'x-signature': 'anything' },
          JSON.stringify({ eventId: 'e', providerRef: payment.providerRef, status: 'CAPTURED' }),
        ),
      ).rejects.toThrow(/PSP_WEBHOOK_SECRET/);
    });

    it('refuses an unknown provider without saying so', async () => {
      const raw = JSON.stringify({ eventId: 'e', providerRef: 'x', status: 'CAPTURED' });
      await expect(payments.webhook('SOMEONE_ELSE', { 'x-signature': sign(raw) }, raw)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('gives the same answer however it was rejected', async () => {
      const raw = JSON.stringify({ eventId: 'e', providerRef: 'x', status: 'CAPTURED' });
      const messages = await Promise.all(
        [
          payments.webhook('SOMEONE_ELSE', { 'x-signature': sign(raw) }, raw),
          payments.webhook(PROVIDER, { 'x-signature': 'deadbeef' }, raw),
          payments.webhook(PROVIDER, { 'x-signature': sign('{}') }, '{}'),
        ].map((p) => p.then(() => 'accepted').catch((e) => e.message)),
      );
      expect(new Set(messages).size).toBe(1);
    });
  });

  describe('replay', () => {
    it('applies a delivery once, however many times it arrives', async () => {
      const payment = await pendingPayment();
      const event = {
        eventId: 'evt-replay',
        providerRef: payment.providerRef,
        status: 'CAPTURED',
        amount: payment.amount,
      };

      expect(await deliver(event)).toEqual({ ok: true });
      expect(await deliver(event)).toEqual({ ok: true, duplicate: true });
      expect(await deliver(event)).toEqual({ ok: true, duplicate: true });

      expect(await prisma.webhookEvent.count()).toBe(1);
    });

    it('does not resurrect a payment that moved on after the first delivery', async () => {
      const payment = await pendingPayment();
      const event = { eventId: 'evt-r2', providerRef: payment.providerRef, status: 'CAPTURED' };
      await deliver(event);

      await prisma.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });
      await deliver(event); // captured payload, replayed

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('REFUNDED');
    });

    it('refuses a delivery carrying no event id, since a replay could not be told from a retry', async () => {
      const payment = await pendingPayment();
      await expect(deliver({ providerRef: payment.providerRef, status: 'CAPTURED' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('survives the same delivery arriving twice at once', async () => {
      const payment = await pendingPayment();
      const event = { eventId: 'evt-race', providerRef: payment.providerRef, status: 'CAPTURED' };

      const results = await Promise.allSettled([deliver(event), deliver(event), deliver(event)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect(await prisma.webhookEvent.count()).toBe(1);
    });
  });

  describe('what the event is allowed to claim', () => {
    it('will not settle a payment at an amount nobody took', async () => {
      const payment = await pendingPayment({ amount: 50_000 });
      await deliver({
        eventId: 'evt-amt',
        providerRef: payment.providerRef,
        status: 'CAPTURED',
        amount: 1,
      });

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('PENDING');
      expect(
        await prisma.auditLog.count({ where: { action: 'PAYMENT_AMOUNT_MISMATCH', entityId: payment.id } }),
      ).toBe(1);
    });

    it('refuses a status that is not a PSP outcome', async () => {
      const payment = await pendingPayment();
      await expect(
        deliver({ eventId: 'evt-bad', providerRef: payment.providerRef, status: 'REFUNDED' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('does not move a payment already refunded', async () => {
      const payment = await pendingPayment({ status: 'REFUNDED' });
      await deliver({ eventId: 'evt-late', providerRef: payment.providerRef, status: 'CAPTURED' });

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('REFUNDED');
    });

    it('accepts a signed event for a reference it has never seen, silently', async () => {
      // Answering differently would let references be probed for existence.
      const result = await deliver({
        eventId: 'evt-ghost',
        providerRef: 'mockdn_nothing_here',
        status: 'CAPTURED',
      });
      expect(result).toMatchObject({ ok: true });
    });

    it('records a failure the PSP reports', async () => {
      const payment = await pendingPayment();
      await deliver({ eventId: 'evt-fail', providerRef: payment.providerRef, status: 'FAILED' });

      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe('FAILED');
    });
  });

  describe('starting a payment', () => {
    it('returns a QR payload for a rail that has one', async () => {
      const intent = await payments.createIntent({
        tender: 'DUITNOW_QR',
        amount: 4500,
        orderRef: 'ord-1',
        idempotencyKey: 'idem-1',
      });
      expect(intent.status).toBe('PENDING');
      expect(intent.qrPayload).toContain('MY');
      expect(intent.providerRef).toMatch(/^mockdn_/);
    });

    it('is idempotent, so a retried tap does not start a second charge', async () => {
      const first = await payments.createIntent({
        tender: 'DUITNOW_QR',
        amount: 4500,
        orderRef: 'ord-2',
        idempotencyKey: 'idem-2',
      });
      const again = await payments.createIntent({
        tender: 'DUITNOW_QR',
        amount: 4500,
        orderRef: 'ord-2',
        idempotencyKey: 'idem-2',
      });
      expect(again.providerRef).toBe(first.providerRef);
    });

    it('settles a tender with no provider immediately — cash and manual card', async () => {
      const intent = await payments.createIntent({
        tender: 'CASH',
        amount: 4500,
        orderRef: 'ord-3',
        idempotencyKey: 'idem-3',
      });
      expect(intent.status).toBe('CAPTURED');
    });

    it('reports an unknown reference as failed rather than pending forever', async () => {
      expect(await payments.status('DUITNOW_QR', 'mockdn_nothing')).toMatchObject({ status: 'FAILED' });
    });

    it('reports a known reference back', async () => {
      const intent = await payments.createIntent({
        tender: 'EWALLET_TNG',
        amount: 900,
        orderRef: 'ord-4',
        idempotencyKey: 'idem-4',
      });
      expect(await payments.status('EWALLET_TNG', intent.providerRef)).toMatchObject({
        providerRef: intent.providerRef,
      });
    });
  });

  describe('reconciliation', () => {
    it('nets the ledger by account for the day', async () => {
      const outlet = await prisma.outlet.create({ data: { name: 'Recon Outlet' } });
      await prisma.ledgerEntry.createMany({
        data: [
          { txnId: 't1', account: 'TENDER_CASH', debit: 5000, credit: 0, outletId: outlet.id },
          { txnId: 't1', account: 'SALES', debit: 0, credit: 5000, outletId: outlet.id },
          { txnId: 't2', account: 'TENDER_CASH', debit: 0, credit: 1500, outletId: outlet.id },
        ],
      });

      const today = new Date().toISOString().slice(0, 10);
      const rows = await payments.reconciliation(today);
      const cash = rows.find((r) => r.account === 'TENDER_CASH');

      expect(cash).toMatchObject({ debit: 5000, credit: 1500, net: 3500 });
      expect(rows.find((r) => r.account === 'SALES')).toMatchObject({ net: -5000 });
    });

    it('covers only the day asked for', async () => {
      await prisma.ledgerEntry.create({
        data: { txnId: 't3', account: 'TENDER_CASH', debit: 100, credit: 0 },
      });
      expect(await payments.reconciliation('1999-01-01')).toEqual([]);
    });
  });
});
