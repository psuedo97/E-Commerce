// All amounts are integers in paise. Prices include GST ("MRP style"), so tax is carved out of the price.

export const SHIPPING_GST_RATE = 18;
export const MAX_LINE_QUANTITY = 10;

export type Fulfilment = 'SHIP' | 'STORE_PICKUP';

export interface PriceLine {
  unitPrice: number; // GST-inclusive
  quantity: number;
  gstRate: number; // percent
}

export interface TaxBreakdown {
  placeOfSupply: string;
  sellerState: string;
  intraState: boolean;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
}

export interface Totals {
  subtotal: number; // goods, GST-inclusive
  shippingFee: number; // GST-inclusive
  total: number;
  tax: TaxBreakdown;
}

export const sellerState = () => process.env.SELLER_STATE ?? 'Uttarakhand';

/** Splits a GST-inclusive amount into taxable value and tax. */
export function splitGst(gross: number, rate: number): { taxable: number; tax: number } {
  const taxable = Math.round((gross * 100) / (100 + rate));
  return { taxable, tax: gross - taxable };
}

/** Flat fee, free above a threshold, free for store pickup. Both numbers are configurable. */
export function computeShipping(subtotal: number, fulfilment: Fulfilment): number {
  if (fulfilment === 'STORE_PICKUP') return 0;
  const flat = Number(process.env.SHIPPING_FLAT_PAISE ?? 5000);
  const freeAbove = Number(process.env.FREE_SHIPPING_ABOVE_PAISE ?? 99900);
  return subtotal >= freeAbove ? 0 : flat;
}

const sameState = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * deliveryState is where the goods are delivered; pickup orders are supplied from the shop's own state.
 * Within the seller's state GST is split into CGST + SGST, otherwise it is IGST.
 */
export function computeTotals(lines: PriceLine[], fulfilment: Fulfilment, deliveryState?: string): Totals {
  const seller = sellerState();
  const placeOfSupply = fulfilment === 'STORE_PICKUP' || !deliveryState ? seller : deliveryState;
  const intraState = sameState(placeOfSupply, seller);

  let subtotal = 0;
  let taxableValue = 0;
  let totalTax = 0;
  for (const line of lines) {
    const gross = line.unitPrice * line.quantity;
    const { taxable, tax } = splitGst(gross, line.gstRate);
    subtotal += gross;
    taxableValue += taxable;
    totalTax += tax;
  }

  const shippingFee = computeShipping(subtotal, fulfilment);
  if (shippingFee > 0) {
    const { taxable, tax } = splitGst(shippingFee, SHIPPING_GST_RATE);
    taxableValue += taxable;
    totalTax += tax;
  }

  const cgst = intraState ? Math.floor(totalTax / 2) : 0;
  const sgst = intraState ? totalTax - cgst : 0; // remainder goes here so the parts always add up
  const igst = intraState ? 0 : totalTax;

  return {
    subtotal,
    shippingFee,
    total: subtotal + shippingFee,
    tax: { placeOfSupply, sellerState: seller, intraState, taxableValue, cgst, sgst, igst, totalTax },
  };
}
