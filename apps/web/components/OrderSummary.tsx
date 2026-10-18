import { formatINR } from '../lib/format';
import type { Tax } from '../lib/types';

type Props = {
  subtotal: number;
  shippingFee: number;
  total: number;
  tax: Tax;
  discount?: number;
};

/** Money breakdown shared by checkout and the order page. Prices already include GST. */
export default function OrderSummary({ subtotal, shippingFee, total, tax, discount = 0 }: Props) {
  return (
    <div className="totals">
      <div className="row"><span>Items</span><span>{formatINR(subtotal)}</span></div>
      {discount > 0 && <div className="row"><span>Discount</span><span>-{formatINR(discount)}</span></div>}
      <div className="row">
        <span>Delivery</span>
        <span>{shippingFee === 0 ? 'Free' : formatINR(shippingFee)}</span>
      </div>
      <div className="row grand"><strong>Total</strong><strong>{formatINR(total)}</strong></div>
      <div className="muted small">
        Includes GST of {formatINR(tax.totalTax)}
        {tax.intraState
          ? ` (CGST ${formatINR(tax.cgst)} + SGST ${formatINR(tax.sgst)})`
          : ` (IGST ${formatINR(tax.igst)})`}
      </div>
    </div>
  );
}
