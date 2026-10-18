import { computeShipping, computeTotals, splitGst } from './pricing';

const OLD_ENV = process.env;
beforeEach(() => {
  process.env = { ...OLD_ENV };
  delete process.env.SELLER_STATE;
  delete process.env.SHIPPING_FLAT_PAISE;
  delete process.env.FREE_SHIPPING_ABOVE_PAISE;
});
afterAll(() => {
  process.env = OLD_ENV;
});

describe('splitGst', () => {
  it('carves tax out of a GST-inclusive price', () => {
    expect(splitGst(10500, 5)).toEqual({ taxable: 10000, tax: 500 });
    expect(splitGst(11800, 18)).toEqual({ taxable: 10000, tax: 1800 });
    expect(splitGst(11200, 12)).toEqual({ taxable: 10000, tax: 1200 });
    expect(splitGst(12800, 28)).toEqual({ taxable: 10000, tax: 2800 });
  });

  it('handles 0% GST', () => {
    expect(splitGst(5000, 0)).toEqual({ taxable: 5000, tax: 0 });
  });

  it('always adds back up to the gross, even when rounding', () => {
    for (const gross of [1, 99, 59900, 74999, 189900, 123457]) {
      for (const rate of [0, 5, 12, 18, 28]) {
        const { taxable, tax } = splitGst(gross, rate);
        expect(taxable + tax).toBe(gross);
        expect(Number.isInteger(taxable) && Number.isInteger(tax)).toBe(true);
      }
    }
  });
});

describe('computeShipping', () => {
  it('charges a flat fee below the free-shipping threshold', () => {
    expect(computeShipping(50000, 'SHIP')).toBe(5000);
    expect(computeShipping(99899, 'SHIP')).toBe(5000);
  });

  it('is free at or above the threshold', () => {
    expect(computeShipping(99900, 'SHIP')).toBe(0);
    expect(computeShipping(500000, 'SHIP')).toBe(0);
  });

  it('is always free for store pickup', () => {
    expect(computeShipping(100, 'STORE_PICKUP')).toBe(0);
  });

  it('reads the fee and threshold from the environment', () => {
    process.env.SHIPPING_FLAT_PAISE = '7000';
    process.env.FREE_SHIPPING_ABOVE_PAISE = '200000';
    expect(computeShipping(150000, 'SHIP')).toBe(7000);
    expect(computeShipping(200000, 'SHIP')).toBe(0);
  });
});

describe('computeTotals', () => {
  const tee = { unitPrice: 59900, quantity: 2, gstRate: 5 };
  const kurta = { unitPrice: 189900, quantity: 1, gstRate: 5 };

  it('splits into CGST + SGST when delivering inside the seller state', () => {
    const t = computeTotals([tee], 'SHIP', 'Uttarakhand');
    expect(t.subtotal).toBe(119800);
    expect(t.shippingFee).toBe(0); // 119800 is above the free-shipping threshold
    expect(t.total).toBe(119800);
    expect(t.tax).toMatchObject({ intraState: true, placeOfSupply: 'Uttarakhand', igst: 0 });
    expect(t.tax.cgst + t.tax.sgst).toBe(t.tax.totalTax);
    expect(t.tax.cgst).toBe(Math.floor(t.tax.totalTax / 2));
  });

  it('uses IGST when delivering to another state', () => {
    const t = computeTotals([tee], 'SHIP', 'Maharashtra');
    expect(t.tax).toMatchObject({ intraState: false, placeOfSupply: 'Maharashtra', cgst: 0, sgst: 0 });
    expect(t.tax.igst).toBe(t.tax.totalTax);
    expect(t.tax.totalTax).toBeGreaterThan(0);
  });

  it('gives the same total tax whichever way it is split', () => {
    expect(computeTotals([tee, kurta], 'SHIP', 'Uttarakhand').tax.totalTax).toBe(
      computeTotals([tee, kurta], 'SHIP', 'Delhi').tax.totalTax,
    );
  });

  it('ignores case and spacing when comparing states', () => {
    expect(computeTotals([tee], 'SHIP', '  uttarakhand ').tax.intraState).toBe(true);
  });

  it('treats store pickup as supplied from the shop state, whatever state is passed', () => {
    const t = computeTotals([tee], 'STORE_PICKUP', 'Kerala');
    expect(t.tax).toMatchObject({ intraState: true, placeOfSupply: 'Uttarakhand' });
    expect(t.shippingFee).toBe(0);
  });

  it('adds shipping on top of goods, with its own 18% GST included in the fee', () => {
    const cheap = { unitPrice: 20000, quantity: 1, gstRate: 5 };
    const t = computeTotals([cheap], 'SHIP', 'Uttarakhand');
    expect(t.shippingFee).toBe(5000);
    expect(t.total).toBe(25000);
    // goods: 20000 incl 5% -> 19048 + 952 ; shipping: 5000 incl 18% -> 4237 + 763
    expect(t.tax.taxableValue).toBe(19048 + 4237);
    expect(t.tax.totalTax).toBe(952 + 763);
  });

  it('always satisfies total = taxable value + tax', () => {
    const baskets = [
      [{ unitPrice: 59900, quantity: 3, gstRate: 5 }],
      [{ unitPrice: 33333, quantity: 7, gstRate: 12 }, { unitPrice: 999, quantity: 1, gstRate: 28 }],
      [{ unitPrice: 1, quantity: 1, gstRate: 18 }],
    ];
    for (const lines of baskets) {
      for (const [f, s] of [['SHIP', 'Uttarakhand'], ['SHIP', 'Goa'], ['STORE_PICKUP', undefined]] as const) {
        const t = computeTotals(lines, f, s);
        expect(t.tax.taxableValue + t.tax.totalTax).toBe(t.total);
        expect(t.tax.cgst + t.tax.sgst + t.tax.igst).toBe(t.tax.totalTax);
      }
    }
  });

  it('mixes GST slabs correctly', () => {
    const t = computeTotals(
      [{ unitPrice: 10500, quantity: 1, gstRate: 5 }, { unitPrice: 11800, quantity: 1, gstRate: 18 }],
      'STORE_PICKUP',
    );
    expect(t.tax).toMatchObject({ taxableValue: 20000, totalTax: 2300 });
  });

  it('honours a different seller state', () => {
    process.env.SELLER_STATE = 'Delhi';
    expect(computeTotals([tee], 'SHIP', 'Delhi').tax.intraState).toBe(true);
    expect(computeTotals([tee], 'SHIP', 'Uttarakhand').tax.intraState).toBe(false);
  });
});
