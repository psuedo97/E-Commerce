const PUBLIC_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

/** Paise to rupees with Indian digit grouping: 189900 -> "₹1,899", 12345678 -> "₹1,23,456.78". */
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
