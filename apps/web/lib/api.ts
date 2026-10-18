// Server-side calls use API_URL; image URLs are opened by the browser, so they use the public origin.
const API_URL = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const PUBLIC_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

export type ProductListItem = {
  id: string; title: string; slug: string; brand: string | null;
  price: number; mrp: number; image: string | null; inStock: boolean;
};
export type ProductList = { items: ProductListItem[]; page: number; limit: number; total: number; totalPages: number };
export type Variant = {
  id: string; sku: string; mrp: number; price: number;
  attributes: Record<string, string>; inStock: boolean; lowStock: boolean;
};
export type ProductDetail = {
  id: string; title: string; slug: string; description: string; brand: string | null; gstRate: number;
  category: { name: string; slug: string };
  images: { id: string; url: string }[];
  variants: Variant[];
};
export type Category = { id: string; name: string; slug: string; children: Category[] };

export async function api<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`API ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    // Only network failures (fetch throws TypeError) become this message; Next.js internal
    // signals and our own "API <status>" errors must pass through untouched.
    if (e instanceof TypeError) throw new Error('Cannot reach the API. Is it running?');
    throw e;
  }
}

/** Paise to rupees, Indian digit grouping: 189900 -> "Rs 1,899" style with the rupee sign. */
export function formatINR(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
  }).format(rupees);
}

export function imageUrl(url: string | null): string | null {
  if (!url) return null;
  return url.startsWith('http') ? url : `${PUBLIC_ORIGIN}${url}`;
}

export function discountPercent(mrp: number, price: number): number {
  return mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0;
}
