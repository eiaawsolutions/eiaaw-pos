'use client';

/**
 * Receipt printing paths:
 *  1. Browser print (works everywhere today) — styled 80mm receipt window.
 *  2. ESC/POS raw bytes builder — send via EIAAW Print Bridge (localhost
 *     agent, v1.0) or WebUSB to Epson/Xprinter class printers. The byte
 *     builder below already produces valid ESC/POS incl. cash-drawer kick.
 */

export interface ReceiptData {
  outletName: string;
  orderNo: string;
  lines: { name: string; qty: number; total: number }[];
  subtotal: number;
  tax: number;
  rounding: number;
  total: number;
  payments: { tender: string; amount: number }[];
  change: number;
  footer?: string;
}

const rm = (sen: number) => 'RM' + (sen / 100).toFixed(2);

export function buildEscPos(r: ReceiptData): Uint8Array {
  const enc = new TextEncoder();
  const bytes: number[] = [];
  const push = (...b: number[]) => bytes.push(...b);
  const text = (s: string) => bytes.push(...enc.encode(s + '\n'));

  push(0x1b, 0x40); // init
  push(0x1b, 0x61, 0x01); // center
  push(0x1b, 0x21, 0x30); // double size
  text(r.outletName);
  push(0x1b, 0x21, 0x00);
  text(`Order ${r.orderNo}`);
  text(new Date().toLocaleString('en-MY'));
  push(0x1b, 0x61, 0x00); // left
  text('-'.repeat(42));
  for (const l of r.lines) text(`${l.qty} x ${l.name}`.padEnd(32).slice(0, 32) + rm(l.total).padStart(10));
  text('-'.repeat(42));
  text('Subtotal'.padEnd(32) + rm(r.subtotal).padStart(10));
  text('SST'.padEnd(32) + rm(r.tax).padStart(10));
  if (r.rounding) text('Rounding'.padEnd(32) + rm(r.rounding).padStart(10));
  push(0x1b, 0x21, 0x10);
  text('TOTAL'.padEnd(26) + rm(r.total).padStart(10));
  push(0x1b, 0x21, 0x00);
  for (const p of r.payments) text(p.tender.padEnd(32) + rm(p.amount).padStart(10));
  if (r.change > 0) text('Change'.padEnd(32) + rm(r.change).padStart(10));
  push(0x1b, 0x61, 0x01);
  text(r.footer ?? 'Powered by EIAAW POS');
  push(0x1b, 0x64, 0x04); // feed
  push(0x1d, 0x56, 0x42, 0x00); // cut
  return new Uint8Array(bytes);
}

/** ESC/POS cash drawer kick pulse (RJ11 via printer) */
export const DRAWER_KICK = new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]);

/** Fallback: styled 80mm receipt via browser print dialog */
export function browserPrint(r: ReceiptData) {
  const w = window.open('', 'receipt', 'width=380,height=600');
  if (!w) return;
  w.document.write(`<html><head><title>${r.orderNo}</title><style>
    body{font-family:monospace;width:72mm;margin:0;padding:8px;font-size:12px}
    .c{text-align:center}.b{font-weight:bold;font-size:14px}
    table{width:100%;border-collapse:collapse}td:last-child{text-align:right}
    hr{border:none;border-top:1px dashed #000}
  </style></head><body>
    <div class="c b">${r.outletName}</div>
    <div class="c">Order ${r.orderNo}<br/>${new Date().toLocaleString('en-MY')}</div><hr/>
    <table>${r.lines.map((l) => `<tr><td>${l.qty} × ${l.name}</td><td>${rm(l.total)}</td></tr>`).join('')}</table><hr/>
    <table>
      <tr><td>Subtotal</td><td>${rm(r.subtotal)}</td></tr>
      <tr><td>SST</td><td>${rm(r.tax)}</td></tr>
      ${r.rounding ? `<tr><td>Rounding</td><td>${rm(r.rounding)}</td></tr>` : ''}
      <tr class="b"><td>TOTAL</td><td>${rm(r.total)}</td></tr>
      ${r.payments.map((p) => `<tr><td>${p.tender}</td><td>${rm(p.amount)}</td></tr>`).join('')}
      ${r.change > 0 ? `<tr><td>Change</td><td>${rm(r.change)}</td></tr>` : ''}
    </table><hr/>
    <div class="c">${r.footer ?? 'Powered by EIAAW POS'}</div>
    <script>window.print();setTimeout(()=>window.close(),400)</script>
  </body></html>`);
  w.document.close();
}
