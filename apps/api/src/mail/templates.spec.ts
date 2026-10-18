import { escapeHtml, EmailOrder, inr, orderConfirmationEmail, refundEmail } from './templates';

const delivery: EmailOrder = {
  number: 1042,
  fulfilment: 'SHIP',
  items: [{ title: 'Classic Cotton T-Shirt (M)', quantity: 2, lineTotal: 119800 }],
  subtotal: 119800,
  shippingFee: 0,
  total: 119800,
  tax: { totalTax: 5705, intraState: true, cgst: 2852, sgst: 2853, igst: 0 },
  shippingAddress: { type: 'SHIP', name: 'Asha Rawat', phone: '9876543210', line1: '12 Rajpur Road', line2: null, city: 'Dehradun', state: 'Uttarakhand', pincode: '248001' },
};

describe('inr', () => {
  it.each([[59900, '₹599'], [189900, '₹1,899'], [4950, '₹49.50'], [12345678, '₹1,23,456.78'], [0, '₹0']])('%i paise -> %s', (p, s) => {
    expect(inr(p)).toBe(s);
  });
});

describe('escapeHtml', () => {
  it('neutralises markup and quotes', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(escapeHtml(`O'Brien & Sons`)).toBe('O&#39;Brien &amp; Sons');
  });
  it('copes with null and numbers', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('orderConfirmationEmail', () => {
  it('names the order, items, totals, GST split and delivery address', () => {
    const e = orderConfirmationEmail('Asha Rawat', delivery);
    expect(e.subject).toBe('Order #1042 confirmed');
    expect(e.text).toContain('Hi Asha,');
    expect(e.text).toContain('order #1042');
    expect(e.text).toContain('Classic Cotton T-Shirt (M) x 2');
    expect(e.text).toContain('Delivery: Free');
    expect(e.text).toContain('Total paid: ₹1,198');
    expect(e.text).toContain('CGST ₹28.52 + SGST ₹28.53');
    expect(e.text).toContain('12 Rajpur Road');
    expect(e.text).toContain('Dehradun, Uttarakhand 248001');
  });

  it('uses IGST for interstate orders and shows the delivery fee', () => {
    const e = orderConfirmationEmail('Asha', { ...delivery, shippingFee: 5000, total: 64900, tax: { totalTax: 3615, intraState: false, cgst: 0, sgst: 0, igst: 3615 } });
    expect(e.text).toContain('IGST ₹36.15');
    expect(e.text).not.toContain('CGST');
    expect(e.text).toContain('Delivery: ₹50');
  });

  it('describes store pickup instead of an address', () => {
    const e = orderConfirmationEmail('Asha', {
      ...delivery, fulfilment: 'STORE_PICKUP',
      shippingAddress: { type: 'PICKUP', locationName: 'KOMA Store', address: 'Rajpur Road', pincode: '248001', contactPhone: '9876500000' },
    });
    expect(e.text).toContain('Pick up from KOMA Store, Rajpur Road, 248001');
    expect(e.text).toContain('9876500000');
    expect(e.text).not.toContain('Delivering to');
  });

  it('escapes customer-typed text in the HTML version (no markup injection)', () => {
    const e = orderConfirmationEmail('<b>Evil</b> Name', {
      ...delivery,
      items: [{ title: '<img src=x onerror=alert(1)>', quantity: 1, lineTotal: 100 }],
      shippingAddress: { ...delivery.shippingAddress, line1: '<script>steal()</script>' },
    });
    expect(e.html).not.toContain('<img');
    expect(e.html).not.toContain('<script>');
    expect(e.html).not.toContain('<b>Evil');
    expect(e.html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
    expect(e.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('greets by first name and falls back politely', () => {
    expect(orderConfirmationEmail('Meera Negi', delivery).text).toContain('Hi Meera,');
    expect(orderConfirmationEmail('', delivery).text).toContain('Hi there,');
  });
});

describe('refundEmail', () => {
  it('states the amount, order and reason', () => {
    const e = refundEmail('Asha Rawat', 1042, 64900, 'Order could not be fulfilled');
    expect(e.subject).toBe('Refund for order #1042');
    expect(e.text).toContain('refunded ₹649 for order #1042');
    expect(e.text).toContain('Reason: Order could not be fulfilled');
  });

  it('escapes the reason in HTML', () => {
    expect(refundEmail('A', 1, 100, '<script>x</script>').html).not.toContain('<script>');
  });
});
