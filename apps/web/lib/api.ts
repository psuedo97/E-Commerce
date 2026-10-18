// Server-side calls use API_URL; image URLs are opened by the browser, so they use the public origin.
const API_URL = process.env.API_URL ?? 'http://localhost:4000/api/v1';

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

export { discountPercent, formatINR, imageUrl } from './format';
