import Link from 'next/link';
import ProductCard from '../../components/ProductCard';
import SortSelect from '../../components/SortSelect';
import { api, type Category, type ProductList } from '../../lib/api';

export const dynamic = 'force-dynamic';

type Search ={ search?: string; category?: string; sort?: string; page?: string };

const SORTS = ['newest', 'price_asc', 'price_desc'];

function href(params: Search, override: Partial<Search>) {
  const merged = { ...params, ...override };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `/products?${s}` : '/products';
}

export default async function Products({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const sort = SORTS.includes(sp.sort ?? '') ? sp.sort! : 'newest';
  const page = Math.max(parseInt(sp.page ?? '1', 10) || 1, 1);

  const qs = new URLSearchParams({ sort, page: String(page), limit: '12' });
  if (sp.search) qs.set('search', sp.search);
  if (sp.category) qs.set('category', sp.category);

  const [data, categories] = await Promise.all([
    api<ProductList>(`/products?${qs}`),
    api<Category[]>('/categories'),
  ]);
  const current = { search: sp.search, category: sp.category, sort };

  return (
    <main className="wrap layout">
      <aside className="side">
        <h3>Categories</h3>
        <ul>
          <li><Link href={href(current, { category: undefined, page: undefined })} className={!sp.category ? 'active' : ''}>All</Link></li>
          {categories?.map((c) => (
            <CategoryLinks key={c.id} c={c} depth={0} current={current} />
          ))}
        </ul>
      </aside>

      <section>
        <div className="bar">
          <span>
            {data?.total ?? 0} product{data?.total === 1 ? '' : 's'}
            {sp.search ? ` for "${sp.search}"` : ''}
          </span>
          <SortSelect value={sort} search={sp.search} category={sp.category} />
        </div>

        {data && data.items.length > 0 ? (
          <div className="grid">{data.items.map((p) => <ProductCard key={p.id} p={p} />)}</div>
        ) : (
          <p className="empty">No products found.</p>
        )}

        {data && data.totalPages > 1 && (
          <nav className="pager" aria-label="Pagination">
            {Array.from({ length: data.totalPages }, (_, i) => i + 1).map((n) =>
              n === data.page ? (
                <span key={n} className="cur">{n}</span>
              ) : (
                <Link key={n} href={href(current, { page: String(n) })}>{n}</Link>
              ),
            )}
          </nav>
        )}
      </section>
    </main>
  );
}

function CategoryLinks({ c, depth, current }: { c: Category; depth: number; current: Search }) {
  return (
    <>
      <li className={depth ? 'child' : ''}>
        <Link href={href(current, { category: c.slug, page: undefined })} className={current.category === c.slug ? 'active' : ''}>
          {c.name}
        </Link>
      </li>
      {c.children.map((child) => <CategoryLinks key={child.id} c={child} depth={depth + 1} current={current} />)}
    </>
  );
}
