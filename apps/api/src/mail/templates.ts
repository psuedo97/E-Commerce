// Plain functions that turn order data into email content, so they are easy to test.

export interface EmailOrder {
  number: number;
  fulfilment: 'SHIP' | 'STORE_PICKUP';
  items: { title: string; quantity: number; lineTotal: number }[];
  subtotal: number;
  shippingFee: number;
  total: number;
  tax: { totalTax: number; intraState: boolean; cgst: number; sgst: number; igst: number };
  shippingAddress: Record<string, unknown>;
}

/** Customer-typed text (names, addresses, product titles) goes into HTML, so it must be escaped. */
export const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Paise to "₹1,23,456.78" (Indian digit grouping). */
export function inr(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
  }).format(rupees);
}

function whereTo(o: EmailOrder): { text: string; html: string } {
  const a = o.shippingAddress as Record<string, string | null | undefined>;
  if (o.fulfilment === 'STORE_PICKUP') {
    const text = `Pick up from ${a.locationName}, ${a.address}, ${a.pincode}. We will call ${a.contactPhone} when it is ready.`;
    return { text, html: `<p>${escapeHtml(text)}</p>` };
  }
  const lines = [a.name, a.line1, a.line2, `${a.city}, ${a.state} ${a.pincode}`, a.phone].filter(Boolean) as string[];
  return {
    text: `Delivering to:\n${lines.join('\n')}`,
    html: `<p><strong>Delivering to</strong><br>${lines.map(escapeHtml).join('<br>')}</p>`,
  };
}

function gstLine(o: EmailOrder): string {
  const t = o.tax;
  return `Includes GST of ${inr(t.totalTax)}` + (t.intraState ? ` (CGST ${inr(t.cgst)} + SGST ${inr(t.sgst)})` : ` (IGST ${inr(t.igst)})`);
}

export function orderConfirmationEmail(name: string, o: EmailOrder): { subject: string; text: string; html: string } {
  const where = whereTo(o);
  const first = name.split(' ')[0] || 'there';
  const text = [
    `Hi ${first},`,
    '',
    `Thank you! We have received your payment for order #${o.number}.`,
    '',
    ...o.items.map((i) => `${i.title} x ${i.quantity}   ${inr(i.lineTotal)}`),
    '',
    `Items: ${inr(o.subtotal)}`,
    `Delivery: ${o.shippingFee === 0 ? 'Free' : inr(o.shippingFee)}`,
    `Total paid: ${inr(o.total)}`,
    gstLine(o),
    '',
    where.text,
    '',
    'KOMA, Dehradun',
  ].join('\n');

  const rows = o.items
    .map((i) => `<tr><td>${escapeHtml(i.title)} × ${i.quantity}</td><td style="text-align:right">${escapeHtml(inr(i.lineTotal))}</td></tr>`)
    .join('');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px">
<p>Hi ${escapeHtml(first)},</p>
<p>Thank you! We have received your payment for <strong>order #${o.number}</strong>.</p>
<table style="width:100%;border-collapse:collapse">${rows}
<tr><td>Items</td><td style="text-align:right">${escapeHtml(inr(o.subtotal))}</td></tr>
<tr><td>Delivery</td><td style="text-align:right">${o.shippingFee === 0 ? 'Free' : escapeHtml(inr(o.shippingFee))}</td></tr>
<tr><td><strong>Total paid</strong></td><td style="text-align:right"><strong>${escapeHtml(inr(o.total))}</strong></td></tr></table>
<p style="color:#666;font-size:13px">${escapeHtml(gstLine(o))}</p>
${where.html}
<p>KOMA, Dehradun</p></div>`;

  return { subject: `Order #${o.number} confirmed`, text, html };
}

export function refundEmail(name: string, orderNumber: number, amount: number, reason: string) {
  const first = name.split(' ')[0] || 'there';
  const text = [
    `Hi ${first},`,
    '',
    `We have refunded ${inr(amount)} for order #${orderNumber}.`,
    `Reason: ${reason}`,
    '',
    'It usually reaches your account within 5 to 7 working days, depending on your bank.',
    '',
    'KOMA, Dehradun',
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px">
<p>Hi ${escapeHtml(first)},</p>
<p>We have refunded <strong>${escapeHtml(inr(amount))}</strong> for order #${orderNumber}.</p>
<p>Reason: ${escapeHtml(reason)}</p>
<p>It usually reaches your account within 5 to 7 working days, depending on your bank.</p>
<p>KOMA, Dehradun</p></div>`;
  return { subject: `Refund for order #${orderNumber}`, text, html };
}
