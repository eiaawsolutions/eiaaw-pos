'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { enqueue, pendingCount, rejectedCount, startAutoDrain } from '@/lib/outbox';
import { browserPrint } from '@/lib/print';
import { MONEY, TAX, type CartLineDto, type CreateOrderDto, type TenderType } from '@eiaaw/shared';

const OUTLET_ID = 'outlet-hq';
const REGISTER_ID = 'reg-1';

type Product = {
  id: string;
  name: string;
  taxCode: string;
  category?: { name: string; color?: string } | null;
  variants: { id: string; sku: string; name: string; price: number; barcodes: { code: string }[] }[];
};

/** The order as the server priced it — the figures the receipt is printed from. */
type PricedOrder = {
  orderNo: string;
  subtotal: number;
  taxTotal: number;
  roundingAdjustment: number;
  total: number;
  lines: { name: string; qty: number; total: number }[];
  payments: { tender: string; amount: number }[];
};

export default function PosPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLineDto[]>([]);
  const [search, setSearch] = useState('');
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [parked, setParked] = useState(0);
  const [payOpen, setPayOpen] = useState(false);
  const [toast, setToast] = useState('');
  const scanBuffer = useRef('');
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api<Product[]>('/catalog/products')
      .then(setProducts)
      .catch(() => setToast('Working offline — cached catalog'));
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const syncCounts = (queued: number) => {
      setPending(queued);
      setParked(rejectedCount());
    };
    const stop = startAutoDrain(REGISTER_ID, syncCounts);
    syncCounts(pendingCount());
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      stop();
    };
  }, []);

  const addVariant = useCallback((p: Product, v: Product['variants'][0]) => {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.variantId === v.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          qty: next[idx].qty + 1,
          taxAmount: taxFor(next[idx].unitPrice, next[idx].qty + 1, next[idx].taxCode),
        };
        return next;
      }
      return [
        ...prev,
        {
          variantId: v.id,
          name: v.name,
          sku: v.sku,
          qty: 1,
          unitPrice: v.price,
          discount: 0,
          taxCode: p.taxCode,
          taxAmount: taxFor(v.price, 1, p.taxCode),
        },
      ];
    });
  }, []);

  // Barcode scanner (keyboard wedge): scanners type fast + end with Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA')
        return;
      if (e.key === 'Enter' && scanBuffer.current.length >= 6) {
        const code = scanBuffer.current;
        scanBuffer.current = '';
        handleScan(code);
      } else if (e.key.length === 1) {
        scanBuffer.current += e.key;
        if (scanTimer.current) clearTimeout(scanTimer.current);
        scanTimer.current = setTimeout(() => (scanBuffer.current = ''), 120);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  function handleScan(code: string) {
    for (const p of products) {
      const v = p.variants.find((v) => v.sku === code || v.barcodes.some((b) => b.code === code));
      if (v) {
        addVariant(p, v);
        setToast(`Scanned: ${v.name}`);
        return;
      }
    }
    setToast(`Unknown barcode: ${code}`);
  }

  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, l) => s + l.unitPrice * l.qty, 0);
    const discount = cart.reduce((s, l) => s + l.discount, 0);
    const tax = cart.reduce((s, l) => s + l.taxAmount, 0);
    const beforeRounding = subtotal - discount;
    return { subtotal, discount, tax, beforeRounding };
  }, [cart]);

  const filtered = products.filter(
    (p) =>
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.variants.some((v) => v.sku.includes(search)),
  );

  async function completeSale(tender: TenderType, tendered: number, reference?: string) {
    const rounding = tender === 'CASH' ? MONEY.cashRounding(totals.beforeRounding) : 0;
    const total = totals.beforeRounding + rounding;
    const order: CreateOrderDto = {
      idempotencyKey: crypto.randomUUID(),
      registerId: REGISTER_ID,
      outletId: OUTLET_ID,
      lines: cart,
      cartDiscount: 0,
      roundingAdjustment: rounding,
      payments: [{ tender, amount: tender === 'CASH' ? tendered : total, reference }],
      placedAt: new Date().toISOString(),
    };
    // What the cart believed, used only until the server answers. The server
    // re-prices from the catalog, so its figures are the sale — and the receipt
    // in the customer's hand should be the one that matches the books.
    let receipt = {
      orderNo: `LOCAL-${order.idempotencyKey.slice(0, 8)}`,
      lines: cart.map((l) => ({ name: l.name, qty: l.qty, total: l.unitPrice * l.qty - l.discount })),
      subtotal: totals.subtotal,
      tax: totals.tax,
      rounding,
      total,
      paid: tender === 'CASH' ? tendered : total,
      change: tender === 'CASH' ? tendered - total : 0,
    };

    try {
      const res = await api<{ order: PricedOrder; change: number }>('/orders', {
        method: 'POST',
        body: JSON.stringify(order),
      });
      receipt = {
        orderNo: res.order.orderNo,
        lines: res.order.lines.map((l) => ({ name: l.name, qty: l.qty, total: l.total })),
        subtotal: res.order.subtotal,
        tax: res.order.taxTotal,
        rounding: res.order.roundingAdjustment,
        total: res.order.total,
        paid: res.order.payments.reduce((s, p) => s + p.amount, 0),
        change: res.change ?? 0,
      };
      if (receipt.total !== total) {
        setToast(`Priced at ${MONEY.fmt(receipt.total)} from the catalog — check the receipt`);
      }
    } catch (e) {
      // A refusal is not an outage. Queueing one retries it every ten seconds
      // forever, and printing a receipt for it hands the customer proof of a
      // sale the books will never contain. Keep the cart, tell the cashier.
      if (e instanceof ApiError && e.isRefusal) {
        setToast(`Sale refused — ${e.message}`);
        setPayOpen(false);
        return;
      }
      enqueue({ ...order, offline: true });
      setPending(pendingCount());
      setToast('Offline — order queued, will sync automatically');
    }

    browserPrint({
      outletName: 'EIAAW Demo Outlet',
      orderNo: receipt.orderNo,
      lines: receipt.lines,
      subtotal: receipt.subtotal,
      tax: receipt.tax,
      rounding: receipt.rounding,
      total: receipt.total,
      payments: [{ tender, amount: receipt.paid }],
      change: receipt.change,
    });
    setCart([]);
    setPayOpen(false);
  }

  return (
    <main style={{ display: 'grid', gridTemplateColumns: '1fr 400px', height: '100vh' }}>
      <section style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="topbar">
          <strong>EIAAW POS · Counter 1</strong>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {pending > 0 && <span className="badge badge-off">{pending} queued</span>}
            {parked > 0 && <span className="badge badge-off">{parked} need attention</span>}
            <span className={`badge ${online ? 'badge-on' : 'badge-off'}`}>
              {online ? 'ONLINE' : 'OFFLINE — still selling'}
            </span>
            <a href="/dashboard">Dashboard</a>
            <a href="/import">AI Import</a>
          </div>
        </div>
        <div style={{ padding: 14 }}>
          <input
            placeholder="Search or scan barcode… (scanner works anywhere on this page)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="grid-tiles" style={{ padding: '0 14px 14px', overflowY: 'auto' }}>
          {filtered.flatMap((p) =>
            p.variants.map((v) => (
              <button key={v.id} className="tile" onClick={() => addVariant(p, v)}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{v.name}</div>
                <div className="muted">{v.sku}</div>
                <div style={{ color: 'var(--accent)', fontWeight: 700, marginTop: 6 }}>
                  {MONEY.fmt(v.price)}
                </div>
              </button>
            )),
          )}
        </div>
      </section>

      <aside style={{ background: 'var(--panel)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 16, flex: 1, overflowY: 'auto' }}>
          <h2 style={{ fontSize: 16, marginBottom: 10 }}>Cart</h2>
          {cart.length === 0 && <p className="muted">Scan or tap items to begin.</p>}
          {cart.map((l, i) => (
            <div
              key={l.variantId}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 0',
                borderBottom: '1px solid var(--panel2)',
              }}
            >
              <div>
                <div>{l.name}</div>
                <div className="muted">
                  <button
                    className="btn-ghost"
                    style={{ padding: '2px 10px' }}
                    onClick={() =>
                      setCart((c) =>
                        c.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                qty: Math.max(1, x.qty - 1),
                                taxAmount: taxFor(x.unitPrice, Math.max(1, x.qty - 1), x.taxCode),
                              }
                            : x,
                        ),
                      )
                    }
                  >
                    −
                  </button>
                  <span style={{ margin: '0 8px' }}>{l.qty}</span>
                  <button
                    className="btn-ghost"
                    style={{ padding: '2px 10px' }}
                    onClick={() =>
                      setCart((c) =>
                        c.map((x, j) =>
                          j === i
                            ? { ...x, qty: x.qty + 1, taxAmount: taxFor(x.unitPrice, x.qty + 1, x.taxCode) }
                            : x,
                        ),
                      )
                    }
                  >
                    +
                  </button>
                  <button
                    className="btn-red"
                    style={{ padding: '2px 10px', marginLeft: 8 }}
                    onClick={() => setCart((c) => c.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              </div>
              <strong>{MONEY.fmt(l.unitPrice * l.qty - l.discount)}</strong>
            </div>
          ))}
        </div>
        <div style={{ padding: 16, borderTop: '1px solid var(--panel2)' }}>
          <Row label="Subtotal" value={MONEY.fmt(totals.subtotal)} />
          <Row label="SST (incl.)" value={MONEY.fmt(totals.tax)} muted />
          <Row label="TOTAL" value={MONEY.fmt(totals.beforeRounding)} big />
          <button
            className="btn-green"
            style={{ width: '100%', marginTop: 12, fontSize: 18 }}
            disabled={!cart.length}
            onClick={() => setPayOpen(true)}
          >
            Charge {MONEY.fmt(totals.beforeRounding)}
          </button>
        </div>
      </aside>

      {payOpen && (
        <PayModal total={totals.beforeRounding} onDone={completeSale} onClose={() => setPayOpen(false)} />
      )}
      {toast && <Toast msg={toast} onDone={() => setToast('')} />}
    </main>
  );
}

/**
 * Cart-side preview of the SST inside a line, using the item's own tax code
 * rather than one flat rate — a zero-rated item priced as if it were SST8 shows
 * the customer tax it is not being charged, and disagrees with the server's
 * figure on every sale.
 *
 * Only ever a preview: the server re-prices from the catalog and its number is
 * the one recorded. So an unrecognised code shows nothing here rather than
 * taking the terminal down — the sale is refused server-side, with a message
 * naming the item to fix.
 */
function taxFor(unitPrice: number, qty: number, taxCode: string) {
  try {
    return TAX.inclusiveComponent(unitPrice * qty, taxCode);
  } catch {
    return 0;
  }
}

function Row({ label, value, big, muted }: { label: string; value: string; big?: boolean; muted?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '3px 0',
        fontSize: big ? 20 : 14,
        fontWeight: big ? 800 : 400,
        color: muted ? 'var(--muted)' : undefined,
      }}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Toast({ msg, onDone }: { msg: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2500);
    return () => clearTimeout(t);
  }, [msg, onDone]);
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        left: 20,
        background: 'var(--panel2)',
        padding: '10px 16px',
        borderRadius: 10,
      }}
    >
      {msg}
    </div>
  );
}

function PayModal({
  total,
  onDone,
  onClose,
}: {
  total: number;
  onDone: (t: TenderType, tendered: number, ref?: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'MENU' | 'CASH' | 'QR' | 'CARD'>('MENU');
  const [tendered, setTendered] = useState('');
  const [qr, setQr] = useState<{ qrPayload?: string; providerRef: string } | null>(null);
  const [qrTender, setQrTender] = useState<TenderType>('DUITNOW_QR');
  const [cardRef, setCardRef] = useState('');
  const rounded = total + MONEY.cashRounding(total);

  async function startQr(tender: TenderType) {
    setQrTender(tender);
    setMode('QR');
    const res = await api<{ qrPayload?: string; providerRef: string }>('/payments/intent', {
      method: 'POST',
      body: JSON.stringify({
        tender,
        amount: total,
        orderRef: crypto.randomUUID().slice(0, 8),
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    setQr(res);
    const poll = setInterval(async () => {
      const s = await api<{ status: string }>(`/payments/status?tender=${tender}&ref=${res.providerRef}`);
      if (s.status === 'CAPTURED') {
        clearInterval(poll);
        onDone(tender, total, res.providerRef);
      }
    }, 2000);
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'grid',
        placeItems: 'center',
      }}
      onClick={onClose}
    >
      <div className="card" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginBottom: 4 }}>Take payment</h2>
        <p className="muted" style={{ marginBottom: 14 }}>
          Total {MONEY.fmt(total)}
        </p>

        {mode === 'MENU' && (
          <div style={{ display: 'grid', gap: 10 }}>
            <button className="btn-green" onClick={() => setMode('CASH')}>
              Cash (rounded {MONEY.fmt(rounded)})
            </button>
            <button className="btn" onClick={() => startQr('DUITNOW_QR')}>
              DuitNow QR
            </button>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <button className="btn-ghost" onClick={() => startQr('EWALLET_TNG')}>
                TNG
              </button>
              <button className="btn-ghost" onClick={() => startQr('EWALLET_GRABPAY')}>
                GrabPay
              </button>
              <button className="btn-ghost" onClick={() => startQr('EWALLET_BOOST')}>
                Boost
              </button>
            </div>
            <button className="btn-ghost" onClick={() => setMode('CARD')}>
              Card terminal (manual entry)
            </button>
          </div>
        )}

        {mode === 'CASH' && (
          <div style={{ display: 'grid', gap: 10 }}>
            <input
              autoFocus
              type="number"
              step="0.05"
              placeholder="Amount tendered (RM)"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {[rounded, Math.ceil(rounded / 1000) * 1000, Math.ceil(rounded / 5000) * 5000].map((v, i) => (
                <button key={i} className="btn-ghost" onClick={() => setTendered((v / 100).toFixed(2))}>
                  {MONEY.fmt(v)}
                </button>
              ))}
            </div>
            {tendered && Number(tendered) * 100 >= rounded && (
              <p style={{ fontSize: 18 }}>
                Change: <strong>{MONEY.fmt(Number(tendered) * 100 - rounded)}</strong>
              </p>
            )}
            <button
              className="btn-green"
              disabled={!tendered || Number(tendered) * 100 < rounded}
              onClick={() => onDone('CASH', Math.round(Number(tendered) * 100))}
            >
              Complete & print receipt
            </button>
          </div>
        )}

        {mode === 'QR' && (
          <div style={{ textAlign: 'center', display: 'grid', gap: 10 }}>
            {qr?.qrPayload ? (
              <>
                <div
                  style={{
                    background: '#fff',
                    color: '#000',
                    padding: 16,
                    borderRadius: 12,
                    fontSize: 10,
                    wordBreak: 'break-all',
                  }}
                >
                  {qr.qrPayload}
                  <p style={{ marginTop: 8, fontWeight: 700 }}>
                    [Dynamic {qrTender.replace('EWALLET_', '')} QR renders here]
                  </p>
                </div>
                <p className="muted">Waiting for customer to scan & pay… (mock auto-confirms in ~5s)</p>
              </>
            ) : (
              <p className="muted">Generating QR…</p>
            )}
          </div>
        )}

        {mode === 'CARD' && (
          <div style={{ display: 'grid', gap: 10 }}>
            <p className="muted">
              Charge {MONEY.fmt(total)} on the bank terminal, then record the approval code. (No card number
              is ever entered or stored.)
            </p>
            <input
              autoFocus
              placeholder="Approval code / last 4 digits"
              value={cardRef}
              onChange={(e) => setCardRef(e.target.value)}
            />
            <button
              className="btn-green"
              disabled={!cardRef}
              onClick={() => onDone('CARD_MANUAL', total, cardRef)}
            >
              Complete & print receipt
            </button>
          </div>
        )}

        <button className="btn-ghost" style={{ width: '100%', marginTop: 12 }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
