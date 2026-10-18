'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCart, useSession } from '../../components/Providers';
import { formatINR, imageUrl } from '../../lib/format';
import type { CartLine } from '../../lib/types';

const NOTES: Partial<Record<CartLine['status'], (l: CartLine) => string>> = {
  LOW_STOCK: (l) => `Only ${l.available} left. Please reduce the quantity.`,
  OUT_OF_STOCK: () => 'Out of stock. Remove it to continue.',
  UNAVAILABLE: () => 'No longer available. Remove it to continue.',
};

export default function CartPage() {
  const { cart, refresh, setQuantity, remove } = useCart();
  const { user, ready } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Stock and prices can change while a cart sits idle, so always look again when the page opens.
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, refresh]);

  async function run(variantId: string, action: () => Promise<unknown>) {
    setBusy(variantId);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  if (!cart) return <main className="wrap"><p className="empty">Loading your cart...</p></main>;

  if (cart.items.length === 0) {
    return (
      <main className="wrap">
        <h1>Your cart</h1>
        <p className="empty">Your cart is empty. <Link href="/products">Start shopping</Link></p>
      </main>
    );
  }

  const checkoutHref = user ? '/checkout' : '/login?next=/checkout';

  return (
    <main className="wrap">
      <h1>Your cart</h1>
      {error && <p className="error-text" role="alert">{error}</p>}

      <ul className="cart-list">
        {cart.items.map((l) => {
          const img = imageUrl(l.image);
          const note = NOTES[l.status]?.(l);
          const max = Math.max(l.available, 1);
          const options = Array.from({ length: Math.max(max, l.quantity) }, (_, i) => i + 1);
          return (
            <li key={l.variantId} className={`cart-line${l.status !== 'OK' ? ' has-issue' : ''}`}>
              <div className="thumb small">{img ? <img src={img} alt="" /> : <span>No image</span>}</div>
              <div className="cart-info">
                <Link href={`/products/${l.slug}`} className="cart-title">{l.title}</Link>
                <div className="muted">{Object.values(l.attributes).join(' / ')}</div>
                <div>{formatINR(l.unitPrice)}</div>
                {note && <div className="error-text">{note}</div>}
              </div>
              <label className="qty">
                Qty
                <select
                  value={l.quantity}
                  disabled={busy === l.variantId || l.status === 'UNAVAILABLE' || l.status === 'OUT_OF_STOCK'}
                  onChange={(e) => run(l.variantId, () => setQuantity(l.variantId, Number(e.target.value)))}
                >
                  {options.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <div className="line-total">{formatINR(l.lineTotal)}</div>
              <button
                type="button" className="linklike" disabled={busy === l.variantId}
                onClick={() => run(l.variantId, () => remove(l.variantId))}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>

      <aside className="summary">
        <div className="row"><span>Subtotal ({cart.itemCount} item{cart.itemCount === 1 ? '' : 's'})</span><strong>{formatINR(cart.subtotal)}</strong></div>
        <p className="muted">Prices include GST. Delivery charges are shown at checkout.</p>
        {cart.hasIssues ? (
          <>
            <button className="btn" disabled>Proceed to checkout</button>
            <p className="error-text">Fix the items marked above to continue.</p>
          </>
        ) : (
          <Link href={checkoutHref} className="btn block">Proceed to checkout</Link>
        )}
      </aside>
    </main>
  );
}
