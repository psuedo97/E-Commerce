'use client';

import Link from 'next/link';
import { useState } from 'react';
import { discountPercent, formatINR } from '../lib/format';
import type { Variant } from '../lib/api';
import { useCart } from './Providers';

const label = (v: Variant) => Object.values(v.attributes).join(' / ');

export default function VariantPicker({ variants }: { variants: Variant[] }) {
  const { add } = useCart();
  const firstInStock = variants.find((v) => v.inStock) ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstInStock.id);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const selected = variants.find((v) => v.id === selectedId)!;
  const off = discountPercent(selected.mrp, selected.price);

  async function addToCart() {
    setBusy(true);
    setResult(null);
    try {
      await add(selected.id, 1);
      setResult({ ok: true, text: 'Added to your cart.' });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'Could not add to cart.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="big">
        <span className="price">{formatINR(selected.price)}</span>
        {off > 0 && <span className="mrp">{formatINR(selected.mrp)}</span>}
        {off > 0 && <span className="off">{off}% off</span>}
      </div>
      <div className="note">Inclusive of all taxes</div>

      {variants.length > 1 || Object.keys(selected.attributes).length > 0 ? (
        <>
          <p style={{ margin: '16px 0 0' }}><strong>Select option</strong></p>
          <div className="sizes">
            {variants.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`size${v.id === selectedId ? ' sel' : ''}`}
                disabled={!v.inStock}
                onClick={() => { setSelectedId(v.id); setResult(null); }}
                aria-pressed={v.id === selectedId}
              >
                {label(v)}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {!selected.inStock && <p className="oos">Out of stock</p>}
      {selected.lowStock && <p className="low">Only a few left</p>}

      <button className="btn" disabled={!selected.inStock || busy} onClick={addToCart}>
        {busy ? 'Adding...' : 'Add to cart'}
      </button>
      {result && (
        <p className={result.ok ? 'ok-text' : 'error-text'} role="status">
          {result.text} {result.ok && <Link href="/cart">View cart</Link>}
        </p>
      )}
    </div>
  );
}
