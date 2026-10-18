import Link from 'next/link';
import ProductCard from '../components/ProductCard';
import { api, type ProductList } from '../lib/api';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const latest = await api<ProductList>('/products?limit=8&sort=newest');

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <h1>Welcome to KOMA</h1>
          <p>Shop our collection online, delivered across India.</p>
        </div>
      </section>
      <main className="wrap">
        <h2>New arrivals</h2>
        {latest && latest.items.length > 0 ? (
          <div className="grid">{latest.items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        ) : (
          <p className="empty">No products yet.</p>
        )}
        <p><Link href="/products">View all products</Link></p>
      </main>
    </>
  );
}
