'use client';

import { useRouter } from 'next/navigation';

export default function SortSelect({ value, search, category }: { value: string; search?: string; category?: string }) {
  const router = useRouter();
  return (
    <label>
      Sort:{' '}
      <select
        value={value}
        onChange={(e) => {
          const qs = new URLSearchParams({ sort: e.target.value });
          if (search) qs.set('search', search);
          if (category) qs.set('category', category);
          router.push(`/products?${qs}`);
        }}
      >
        <option value="newest">Newest</option>
        <option value="price_asc">Price: low to high</option>
        <option value="price_desc">Price: high to low</option>
      </select>
    </label>
  );
}
