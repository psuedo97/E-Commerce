'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import OrderSummary from '../../components/OrderSummary';
import { useCart, useSession } from '../../components/Providers';
import { ApiError, client } from '../../lib/client';
import { formatINR } from '../../lib/format';
import { INDIAN_STATES } from '../../lib/states';
import type { Address, CheckoutRequest, Order, Quote, Store } from '../../lib/types';

type Shortage = { variantId: string; title?: string; requested: number; available: number };

export default function CheckoutPage() {
  const { user, ready } = useSession();
  const { cart, refresh } = useCart();
  const router = useRouter();

  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [mode, setMode] = useState<'SHIP' | 'STORE_PICKUP'>('SHIP');
  const [addressId, setAddressId] = useState<string>('');
  const [storeId, setStoreId] = useState<string>('');
  const [phone, setPhone] = useState('');
  const [adding, setAdding] = useState(false);

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<{ message: string; items: Shortage[] } | null>(null);

  // Checkout needs an account: send guests to log in and bring them back here (their cart is merged).
  useEffect(() => {
    if (ready && !user) router.replace('/login?next=/checkout');
  }, [ready, user, router]);

  useEffect(() => {
    if (!user) return;
    void refresh();
    client.get<Address[]>('/users/me/addresses').then((list) => {
      setAddresses(list);
      setAddressId((cur) => cur || list.find((a) => a.isDefault)?.id || list[0]?.id || '');
    }).catch(() => setAddresses([]));
    client.get<Store[]>('/stores').then((list) => {
      setStores(list);
      setStoreId((cur) => cur || list[0]?.id || '');
    }).catch(() => setStores([]));
  }, [user, refresh]);

  // What we would send: null until the choices are complete.
  const request = useMemo<CheckoutRequest | null>(() => {
    if (mode === 'SHIP') return addressId ? { fulfilment: 'SHIP', addressId } : null;
    const contact = phone.trim();
    if (!storeId) return null;
    if (!user?.phone && !/^[6-9]\d{9}$/.test(contact)) return null;
    return { fulfilment: 'STORE_PICKUP', pickupLocationId: storeId, ...(contact ? { contactPhone: contact } : {}) };
  }, [mode, addressId, storeId, phone, user?.phone]);

  const requestKey = JSON.stringify(request);
  const cartKey = cart ? `${cart.itemCount}:${cart.subtotal}` : '';

  // Re-price whenever the choices or the cart change.
  useEffect(() => {
    if (!request || !cart || cart.items.length === 0) { setQuote(null); setQuoteError(null); return; }
    let stale = false;
    client.post<Quote>('/checkout/quote', request)
      .then((q) => { if (!stale) { setQuote(q); setQuoteError(null); } })
      .catch((e) => { if (!stale) { setQuote(null); setQuoteError(e instanceof Error ? e.message : 'Could not price your order.'); } });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, cartKey]);

  const saveAddress = useCallback(async (body: Record<string, string>) => {
    const created = await client.post<Address>('/users/me/addresses', { ...body, line2: body.line2 || undefined });
    setAddresses((cur) => [...(cur ?? []), created]);
    setAddressId(created.id);
    setAdding(false);
  }, []);

  async function placeOrder() {
    if (!request) return;
    setPlacing(true);
    setPlaceError(null);
    try {
      const order = await client.post<Order>('/checkout', request);
      await refresh(); // the cart is now empty
      router.push(`/orders/${order.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        const items = ((e.body as { items?: Shortage[] } | null)?.items ?? []) as Shortage[];
        setPlaceError({ message: e.message, items });
      } else {
        setPlaceError({ message: 'Could not place your order. Please try again.', items: [] });
      }
      await refresh();
      setPlacing(false);
    }
  }

  if (!ready || !user) return <main className="wrap"><p className="empty">Loading...</p></main>;
  if (!cart) return <main className="wrap"><p className="empty">Loading your cart...</p></main>;
  if (cart.items.length === 0) {
    return (
      <main className="wrap">
        <h1>Checkout</h1>
        <p className="empty">Your cart is empty. <Link href="/products">Continue shopping</Link></p>
      </main>
    );
  }

  const canPlace = !!request && !!quote && quote.stockIssues.length === 0 && !placing;

  return (
    <main className="wrap checkout">
      <h1>Checkout</h1>

      <p className="notice">
        After you place your order we hold your items for 30 minutes while you pay on the next page.
      </p>

      <div className="checkout-grid">
        <section>
          <h2>1. How would you like to receive it?</h2>
          <div className="choice">
            <label className={`radio-card${mode === 'SHIP' ? ' on' : ''}`}>
              <input type="radio" name="mode" checked={mode === 'SHIP'} onChange={() => setMode('SHIP')} />
              <span><strong>Home delivery</strong><br /><span className="muted">Delivered by courier</span></span>
            </label>
            <label className={`radio-card${mode === 'STORE_PICKUP' ? ' on' : ''}${stores.length === 0 ? ' disabled' : ''}`}>
              <input type="radio" name="mode" disabled={stores.length === 0} checked={mode === 'STORE_PICKUP'} onChange={() => setMode('STORE_PICKUP')} />
              <span><strong>Collect from our shop</strong><br /><span className="muted">Free</span></span>
            </label>
          </div>

          {mode === 'SHIP' ? (
            <>
              <h2>2. Delivery address</h2>
              {addresses === null ? (
                <p className="muted">Loading addresses...</p>
              ) : (
                <>
                  {addresses.map((a) => (
                    <label key={a.id} className={`radio-card${addressId === a.id ? ' on' : ''}`}>
                      <input type="radio" name="address" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                      <span>
                        <strong>{a.name}</strong> <span className="muted">{a.phone}</span><br />
                        {a.line1}{a.line2 ? `, ${a.line2}` : ''}<br />
                        {a.city}, {a.state} {a.pincode}
                      </span>
                    </label>
                  ))}
                  {adding ? (
                    <AddressForm onSave={saveAddress} onCancel={() => setAdding(false)} defaultName={user.name} />
                  ) : (
                    <button type="button" className="btn secondary" onClick={() => setAdding(true)}>
                      {addresses.length === 0 ? 'Add a delivery address' : 'Add another address'}
                    </button>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <h2>2. Pickup shop</h2>
              {stores.map((s) => (
                <label key={s.id} className={`radio-card${storeId === s.id ? ' on' : ''}`}>
                  <input type="radio" name="store" checked={storeId === s.id} onChange={() => setStoreId(s.id)} />
                  <span><strong>{s.name}</strong><br />{s.address}, {s.pincode}</span>
                </label>
              ))}
              <label className="form">
                Mobile number for pickup updates {user.phone && <span className="muted">(we have {user.phone})</span>}
                <input
                  value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="numeric" maxLength={10}
                  placeholder={user.phone ?? '10-digit number'}
                />
              </label>
            </>
          )}
        </section>

        <aside className="summary">
          <h2>Order summary</h2>
          <ul className="mini-items">
            {/* Before a price quote exists, show the cart lines named the same way the order will name them. */}
            {(quote?.items ?? cart.items.map((l) => {
              const options = Object.values(l.attributes).join(' / ');
              return { ...l, title: options ? `${l.title} (${options})` : l.title };
            })).map((l) => (
              <li key={l.variantId}><span>{l.title} × {l.quantity}</span><span>{formatINR(l.lineTotal)}</span></li>
            ))}
          </ul>

          {quote ? (
            <OrderSummary subtotal={quote.subtotal} shippingFee={quote.shippingFee} total={quote.total} tax={quote.tax} />
          ) : (
            <p className="muted">{quoteError ? '' : 'Choose how you want to receive your order to see the total.'}</p>
          )}
          {quoteError && <p className="error-text" role="alert">{quoteError}</p>}
          {quote && quote.stockIssues.length > 0 && (
            <div className="error-text" role="alert">
              Some items are short on stock. <Link href="/cart">Update your cart</Link>
              <ul>{quote.stockIssues.map((s) => <li key={s.variantId}>{s.title}: you asked for {s.requested}, {s.available} available</li>)}</ul>
            </div>
          )}
          {placeError && (
            <div className="error-text" role="alert">
              {placeError.message}
              {placeError.items.length > 0 && (
                <ul>{placeError.items.map((s) => (
                  <li key={s.variantId}>{s.title ?? 'An item'}{s.requested != null ? `: you asked for ${s.requested}, ${s.available} available` : ''}</li>
                ))}</ul>
              )}
            </div>
          )}
          <button className="btn block" disabled={!canPlace} onClick={placeOrder}>
            {placing ? 'Placing order...' : 'Place order'}
          </button>
        </aside>
      </div>
    </main>
  );
}

function AddressForm({ onSave, onCancel, defaultName }: {
  onSave: (body: Record<string, string>) => Promise<void>;
  onCancel: () => void;
  defaultName: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v).trim()]));
    setBusy(true);
    setError(null);
    try {
      await onSave(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the address.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="form address-form">
      <label>Full name<input name="name" required minLength={2} defaultValue={defaultName} /></label>
      <label>Mobile number<input name="phone" required inputMode="numeric" pattern="[6-9][0-9]{9}" maxLength={10} placeholder="10-digit number" /></label>
      <label>Address line 1<input name="line1" required minLength={3} placeholder="House no., street" /></label>
      <label>Address line 2 <span className="muted">(optional)</span><input name="line2" placeholder="Landmark, area" /></label>
      <div className="two">
        <label>City<input name="city" required minLength={2} /></label>
        <label>Pincode<input name="pincode" required inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} /></label>
      </div>
      <label>State
        <select name="state" required defaultValue="Uttarakhand">
          {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save address'}</button>
        <button type="button" className="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
