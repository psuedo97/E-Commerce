import Link from 'next/link';
import { discountPercent, formatINR, imageUrl, type ProductListItem } from '../lib/api';

export default function ProductCard({ p }: { p: ProductListItem }) {
  const src = imageUrl(p.image);
  const off = discountPercent(p.mrp, p.price);
  return (
    <Link href={`/products/${p.slug}`} className="card">
      <div className="thumb">
        {src ? <img src={src} alt={p.title} loading="lazy" /> : <span>No image</span>}
      </div>
      <div className="title">{p.title}</div>
      {p.brand && <div className="brand">{p.brand}</div>}
      <div>
        <span className="price">{formatINR(p.price)}</span>
        {off > 0 && <span className="mrp">{formatINR(p.mrp)}</span>}
        {off > 0 && <span className="off">{off}% off</span>}
      </div>
      {!p.inStock && <div className="oos">Out of stock</div>}
    </Link>
  );
}
