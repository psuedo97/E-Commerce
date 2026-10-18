import Link from 'next/link';
import { notFound } from 'next/navigation';
import VariantPicker from '../../../components/VariantPicker';
import { api, imageUrl, type ProductDetail } from '../../../lib/api';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await api<ProductDetail>(`/products/${slug}`);
  return { title: p ? `${p.title} | KOMA` : 'Product not found | KOMA', description: p?.description.slice(0, 160) };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await api<ProductDetail>(`/products/${slug}`);
  if (!p) notFound();

  const images = p.images.map((i) => imageUrl(i.url)!).filter(Boolean);

  return (
    <main className="wrap">
      <div className="crumbs">
        <Link href="/products">Products</Link> / <Link href={`/products?category=${p.category.slug}`}>{p.category.name}</Link>
      </div>
      <div className="product">
        <div className="gallery">
          <div className="main">
            {images[0] ? <img src={images[0]} alt={p.title} /> : <span>No image</span>}
          </div>
          {images.length > 1 && (
            <div className="thumbs">
              {images.map((src, i) => <img key={src} src={src} alt={`${p.title} view ${i + 1}`} />)}
            </div>
          )}
        </div>
        <div className="info">
          <h1>{p.title}</h1>
          {p.brand && <div className="brand">{p.brand}</div>}
          <VariantPicker variants={p.variants} />
          <div className="desc">{p.description}</div>
        </div>
      </div>
    </main>
  );
}
