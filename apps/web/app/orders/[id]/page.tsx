'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import OrderSummary from '../../../components/OrderSummary';
import { useSession } from '../../../components/Providers';
import { ApiError, client } from '../../../lib/client';
import { formatINR } from '../../../lib/format';
import { canCancel, minutesLeft, statusLabel } from '../../../lib/orders';
import type { Order } from '../../../lib/types';

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const { user, ready } = useSession();
  const router = useRouter();
  const [order, setOrder] = useState<Order | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (ready && !user) router.replace(`/login?next=/orders/${id}`);
  }, [ready, user, router, id]);

  useEffect(() => {
    if (!user) return;
    client.get<Order>(`/orders/${id}`).then(setOrder).catch((e) => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(e.message);
    });
  }, [user, id]);

  async function cancel() {
    if (!window.confirm('Cancel this order? Your items will be released.')) return;
    setCancelling(true);
    setError(null);
    try {
      setOrder(await client.post<Order>(`/orders/${id}/cancel`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the order.');
    } finally {
      setCancelling(false);
    }
  }

  if (!ready || !user) return <main className="wrap"><p className="empty">Loading...</p></main>;
  if (notFound) return <main className="wrap"><h1>Order not found</h1><p><Link href="/orders">Back to your orders</Link></p></main>;
  if (!order) return <main className="wrap">{error ? <p className="error-text" role="alert">{error}</p> : <p className="empty">Loading your order...</p>}</main>;

  const left = minutesLeft(order.expiresAt);
  const addr = order.shippingAddress;
  const isPickup = order.fulfilment === 'STORE_PICKUP';

  return (
    <main className="wrap">
      <p className="crumbs"><Link href="/orders">Your orders</Link> / #{order.number}</p>
      <h1>
        Order #{order.number} <span className={`status ${order.status.toLowerCase()}`}>{statusLabel(order.status)}</span>
      </h1>
      <p className="muted">Placed on {new Date(order.createdAt).toLocaleString('en-IN')}</p>

      {order.status === 'PENDING' && (
        <p className="notice">
          Your items are held for {left} more minute{left === 1 ? '' : 's'}. Online payment is not switched on yet, so
          this order will be cancelled automatically when the time runs out.
        </p>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}

      <div className="checkout-grid">
        <section>
          <h2>Items</h2>
          <ul className="mini-items">
            {order.items.map((i) => (
              <li key={i.variantId}>
                <span>{i.title} × {i.quantity} <span className="muted">({formatINR(i.unitPrice)} each)</span></span>
                <span>{formatINR(i.lineTotal)}</span>
              </li>
            ))}
          </ul>

          <h2>{isPickup ? 'Pickup' : 'Delivery address'}</h2>
          {isPickup ? (
            <p>
              <strong>{addr.locationName}</strong><br />
              {addr.address}, {addr.pincode}<br />
              <span className="muted">We will call {addr.contactPhone} when it is ready.</span>
            </p>
          ) : (
            <p>
              <strong>{addr.name}</strong> <span className="muted">{addr.phone}</span><br />
              {addr.line1}{addr.line2 ? `, ${addr.line2}` : ''}<br />
              {addr.city}, {addr.state} {addr.pincode}
            </p>
          )}
        </section>

        <aside className="summary">
          <h2>Payment summary</h2>
          <OrderSummary subtotal={order.subtotal} shippingFee={order.shippingFee} total={order.total} tax={order.tax} discount={order.discount} />
          {canCancel(order.status) && (
            <button className="btn secondary block" disabled={cancelling} onClick={cancel}>
              {cancelling ? 'Cancelling...' : 'Cancel order'}
            </button>
          )}
        </aside>
      </div>
    </main>
  );
}
