import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createTestApp, resetDb, seedCatalog } from './helpers';

describe('Catalog (public)', () => {
  let app: NestExpressApplication;
  const prisma = new PrismaClient();
  const get = (path: string) => request(app.getHttpServer()).get(`/api/v1${path}`);

  beforeAll(async () => {
    await resetDb(prisma);
    await seedCatalog(prisma);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('GET /products', () => {
    it('lists active products with price, mrp, image and stock flag', async () => {
      const res = await get('/products').expect(200);
      expect(res.body).toMatchObject({ page: 1, limit: 12, total: 3, totalPages: 1 });
      const tee = res.body.items.find((p: any) => p.slug === 'classic-cotton-t-shirt');
      expect(tee).toMatchObject({ title: 'Classic Cotton T-Shirt', brand: 'KOMA', price: 59900, mrp: 79900, image: null, inStock: true });
    });

    it('does not leak internal fields', async () => {
      const res = await get('/products').expect(200);
      expect(Object.keys(res.body.items[0]).sort()).toEqual(
        ['brand', 'id', 'image', 'inStock', 'mrp', 'price', 'slug', 'status', 'title'],
      );
    });

    describe('search', () => {
      it.each([
        ['title', 'kurta', ['embroidered-cotton-kurta']],
        ['case-insensitively', 'KURTA', ['embroidered-cotton-kurta']],
        ['description', 'embroidery', ['embroidered-cotton-kurta']],
        ['brand', 'koma', ['classic-cotton-t-shirt', 'embroidered-cotton-kurta', 'graphic-print-t-shirt']],
      ])('matches by %s', async (_label, term, slugs) => {
        const res = await get(`/products?search=${term}`).expect(200);
        expect(res.body.items.map((p: any) => p.slug).sort()).toEqual(slugs);
      });

      it('returns an empty list when nothing matches', async () => {
        const res = await get('/products?search=zzzz').expect(200);
        expect(res.body).toMatchObject({ total: 0, items: [], totalPages: 1 });
      });

      it('treats quotes and SQL wildcards as plain text', async () => {
        await get(`/products?search=${encodeURIComponent("'; DROP TABLE \"Product\"; --")}`).expect(200).expect((r) => expect(r.body.total).toBe(0));
        await get('/products?search=%25').expect(200);
        const still = await get('/products').expect(200);
        expect(still.body.total).toBe(3);
      });
    });

    describe('category filter', () => {
      it.each([
        ['men', 2], // parent includes sub-category products
        ['t-shirts', 2],
        ['women', 1],
        ['kurtas', 1],
        ['does-not-exist', 0],
      ])('%s -> %i products', async (slug, total) => {
        const res = await get(`/products?category=${slug}`).expect(200);
        expect(res.body.total).toBe(total);
      });
    });

    describe('price filter and sorting', () => {
      it('filters by price range in paise', async () => {
        const res = await get('/products?minPrice=60000&maxPrice=100000').expect(200);
        expect(res.body.items.map((p: any) => p.price)).toEqual([74900]);
      });

      it('sorts price low to high', async () => {
        const res = await get('/products?sort=price_asc').expect(200);
        expect(res.body.items.map((p: any) => p.price)).toEqual([59900, 74900, 189900]);
      });

      it('sorts price high to low', async () => {
        const res = await get('/products?sort=price_desc').expect(200);
        expect(res.body.items.map((p: any) => p.price)).toEqual([189900, 74900, 59900]);
      });

      it('sorts newest first by default', async () => {
        const res = await get('/products').expect(200);
        expect(res.body.items.map((p: any) => p.slug)).toEqual([
          'embroidered-cotton-kurta', 'graphic-print-t-shirt', 'classic-cotton-t-shirt',
        ]);
      });

      it('combines category, price and sort', async () => {
        const res = await get('/products?category=men&maxPrice=70000&sort=price_desc').expect(200);
        expect(res.body.items.map((p: any) => p.slug)).toEqual(['classic-cotton-t-shirt']);
      });
    });

    describe('pagination', () => {
      it('returns the requested page and totals', async () => {
        const p1 = await get('/products?limit=2&page=1&sort=price_asc').expect(200);
        const p2 = await get('/products?limit=2&page=2&sort=price_asc').expect(200);
        expect(p1.body).toMatchObject({ total: 3, totalPages: 2 });
        expect(p1.body.items.map((p: any) => p.price)).toEqual([59900, 74900]);
        expect(p2.body.items.map((p: any) => p.price)).toEqual([189900]);
      });

      it('returns an empty page past the end', async () => {
        const res = await get('/products?limit=2&page=9').expect(200);
        expect(res.body).toMatchObject({ items: [], total: 3, totalPages: 2 });
      });
    });

    describe('query validation', () => {
      it.each([
        'limit=500', 'limit=0', 'page=0', 'page=abc', 'sort=random', 'minPrice=-1', 'maxPrice=1.5',
      ])('rejects %s', async (qs) => {
        await get(`/products?${qs}`).expect(400);
      });
    });

    describe('visibility and stock', () => {
      it('hides draft and archived products', async () => {
        const category = await prisma.category.findUniqueOrThrow({ where: { slug: 't-shirts' } });
        for (const status of ['DRAFT', 'ARCHIVED'] as const) {
          await prisma.product.create({
            data: {
              title: `Hidden ${status}`, slug: `hidden-${status.toLowerCase()}`, description: 'x', status,
              categoryId: category.id, minPrice: 10000,
              variants: { create: [{ sku: `HIDE-${status}`, mrp: 10000, price: 10000, attributes: { size: 'M' } }] },
            },
          });
        }
        const list = await get('/products?search=hidden').expect(200);
        expect(list.body.total).toBe(0);
        await get('/products/hidden-draft').expect(404);
        await get('/products/hidden-archived').expect(404);
      });

      it('marks a product out of stock when no variant has stock', async () => {
        const category = await prisma.category.findUniqueOrThrow({ where: { slug: 'kurtas' } });
        await prisma.product.create({
          data: {
            title: 'Sold Out Kurta', slug: 'sold-out-kurta', description: 'x', status: 'ACTIVE',
            categoryId: category.id, minPrice: 50000,
            variants: { create: [{ sku: 'SOLD-M', mrp: 50000, price: 50000, attributes: { size: 'M' } }] },
          },
        });
        const res = await get('/products?search=sold+out').expect(200);
        expect(res.body.items[0]).toMatchObject({ slug: 'sold-out-kurta', inStock: false });
      });
    });
  });

  describe('GET /products/:slug', () => {
    it('returns the product with category, images and variants', async () => {
      const res = await get('/products/classic-cotton-t-shirt').expect(200);
      expect(res.body).toMatchObject({
        title: 'Classic Cotton T-Shirt', brand: 'KOMA', category: { name: 'T-Shirts', slug: 't-shirts' }, images: [],
      });
      expect(res.body.variants.map((v: any) => v.attributes.size).sort()).toEqual(['L', 'M', 'S']);
    });

    it('reports per-variant availability: stocked sizes in, unstocked size out', async () => {
      const res = await get('/products/classic-cotton-t-shirt').expect(200);
      const bySize = Object.fromEntries(res.body.variants.map((v: any) => [v.attributes.size, v]));
      expect(bySize.S.inStock).toBe(true);
      expect(bySize.M.inStock).toBe(true);
      expect(bySize.L.inStock).toBe(false);
    });

    it('exposes only safe variant fields (no stock counts, barcode, or cost data)', async () => {
      const res = await get('/products/classic-cotton-t-shirt').expect(200);
      expect(Object.keys(res.body.variants[0]).sort()).toEqual(['attributes', 'id', 'inStock', 'lowStock', 'mrp', 'price', 'sku']);
    });

    it('subtracts reserved units, and flags low stock at 5 or fewer', async () => {
      const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'SEED-2-S' } });
      const level = { variantId_locationId: { variantId: variant.id, locationId: (await prisma.location.findFirstOrThrow()).id } };

      await prisma.stockLevel.update({ where: level, data: { onHand: 10, reserved: 6 } }); // 4 available
      let res = await get('/products/graphic-print-t-shirt').expect(200);
      expect(res.body.variants.find((v: any) => v.sku === 'SEED-2-S')).toMatchObject({ inStock: true, lowStock: true });

      await prisma.stockLevel.update({ where: level, data: { onHand: 10, reserved: 10 } }); // none available
      res = await get('/products/graphic-print-t-shirt').expect(200);
      expect(res.body.variants.find((v: any) => v.sku === 'SEED-2-S')).toMatchObject({ inStock: false, lowStock: false });

      await prisma.stockLevel.update({ where: level, data: { onHand: 10, reserved: 0 } }); // plenty
      res = await get('/products/graphic-print-t-shirt').expect(200);
      expect(res.body.variants.find((v: any) => v.sku === 'SEED-2-S')).toMatchObject({ inStock: true, lowStock: false });
    });

    it('returns 404 for an unknown slug', async () => {
      await get('/products/does-not-exist').expect(404);
    });
  });

  describe('GET /categories', () => {
    it('returns a tree with sub-categories nested under their parent', async () => {
      const res = await get('/categories').expect(200);
      expect(res.body.map((c: any) => c.slug)).toEqual(['men', 'women']);
      const men = res.body.find((c: any) => c.slug === 'men');
      expect(men.children.map((c: any) => c.slug)).toEqual(['t-shirts']);
      expect(men.children[0].children).toEqual([]);
    });
  });
});
