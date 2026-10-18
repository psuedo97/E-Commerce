'use client';

import { useState } from 'react';
import { discountPercent, formatINR, type Variant } from '../lib/api';

const label = (v: Variant) => Object.values(v.attributes).join(' / ');

export default function VariantPicker({ variants }: { variants: Variant[] }) {
  const firstInStock = variants.find((v) => v.inStock) ?? variants[0];
  const [selectedId, setSelectedId] = useState(firstInStock.id);
  const selected = variants.find((v) => v.id === selectedId)!;
  const off = discountPercent(selected.mrp, selected.price);

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
                onClick={() => setSelectedId(v.id)}
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

      {/* Wired to the cart in Phase 4. */}
      <button className="btn" disabled>Add to cart (coming soon)</button>
    </div>
  );
}
