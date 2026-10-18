'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '../../components/Providers';
import { client } from '../../lib/client';
import { formatINR } from '../../lib/format';
import { statusLabel } from '../../lib/orders';
import type { Order, Paged } from '../../lib/types';

export default function OrdersPage() {
  const { user, ready } = useSession();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<Order> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ready && !user) router.replace('/login?next=/orders');
  }, [ready, user, router]);

  useEffect(() => {
    if (!user) return;
    setError(null);
    client.get<Paged<Order>>(`/orders?page=${page}&limit=10`).then(setData).catch((e) => setError(e.message));
  }, [user, page]);

  if (!ready || !user) return <main className="wrap"><p className="empty">Loading...</p></main>;

  return (
    <main className="wrap">
      <h1>Your orders</h1>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!data && !error && <p className="empty">Loading your orders...</p>}
      {data && data.items.length === 0 && <p className="empty">You have not placed any orders yet. <Link href="/products">Start shopping</Link></p>}

      {data && data.items.length > 0 && (
        <>
          <ul className="order-list">
            {data.items.map((o) => (
              <li key={o.id}>
                <Link href={`/orders/${o.id}`} className="order-row">
                  <span><strong>Order #{o.number}</strong><br /><span className="muted">{new Date(o.createdAt).toLocaleString('en-IN')}</span></span>
                  <span className={`status ${o.status.toLowerCase()}`}>{statusLabel(o.status)}</span>
                  <span>{o.items.reduce((n, i) => n + i.quantity, 0)} item(s)</span>
                  <strong>{formatINR(o.total)}</strong>
                </Link>
              </li>
            ))}
          </ul>
          {data.totalPages > 1 && (
            <nav className="pager" aria-label="Pagination">
              <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {data.page} of {data.totalPages}</span>
              <button className="btn secondary" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>Next</button>
            </nav>
          )}
        </>
      )}
    </main>
  );
}
