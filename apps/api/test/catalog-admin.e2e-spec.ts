import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { existsSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { adminToken, createTestApp, registerCustomer, resetDb, seedCatalog, TINY_PNG } from './helpers';

describe('Catalog (admin)', () => {
  let app: NestExpressApplication;
  let token: string;
  const prisma = new PrismaClient();

  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const get = (path: string) => asAdmin(http().get(`/api/v1${path}`));
  const post = (path: string, body?: object) => asAdmin(http().post(`/api/v1${path}`)).send(body);
  const patch = (path: string, body: object) => asAdmin(http().patch(`/api/v1${path}`)).send(body);
  const del = (path: string) => asAdmin(http().delete(`/api/v1${path}`));
  const publicGet = (path: string) => http().get(`/api/v1${path}`);

  let categoryId: string;
  let skuCounter = 0;
  const variant = (over: object = {}) => ({
    sku: `ADM-${++skuCounter}`, mrp: 150000, price: 120000, attributes: { size: 'M' }, ...over,
  });
  const newProduct = async (over: object = {}) =>
    (await post('/admin/products', {
      title: 'Test Hoodie', description: 'A warm hoodie for testing.', categoryId, hsnCode: '6110', gstRate: 12,
      variants: [variant()], ...over,
    }).expect(201)).body;

  beforeAll(async () => {
    await resetDb(prisma);
    const seeded = await seedCatalog(prisma);
    categoryId = seeded.tshirts.id;
    app = await createTestApp();
    token = await adminToken(app, prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('access control', () => {
    const routes: [string, string][] = [
      ['post', '/admin/categories'], ['patch', '/admin/categories/x'], ['delete', '/admin/categories/x'],
      ['get', '/admin/products'], ['get', '/admin/products/x'], ['post', '/admin/products'],
      ['patch', '/admin/products/x'], ['delete', '/admin/products/x'], ['post', '/admin/products/x/variants'],
      ['patch', '/admin/variants/x'], ['delete', '/admin/variants/x'], ['post', '/admin/products/x/images'],
      ['delete', '/admin/images/x'],
    ];

    it.each(routes)('%s %s requires a token (401)', async (method, path) => {
      await (http() as any)[method](`/api/v1${path}`).expect(401);
    });

    it.each(routes)('%s %s is forbidden for customers (403)', async (method, path) => {
      const customer = await registerCustomer(app);
      await (http() as any)[method](`/api/v1${path}`).set('Authorization', `Bearer ${customer}`).expect(403);
    });

    it('rejects a garbage token', async () => {
      await http().get('/api/v1/admin/products').set('Authorization', 'Bearer not.a.token').expect(401);
    });
  });

  describe('categories', () => {
    it('creates a category with a generated slug', async () => {
      const res = await post('/admin/categories', { name: 'Hoodies & Jackets' }).expect(201);
      expect(res.body).toMatchObject({ name: 'Hoodies & Jackets', slug: 'hoodies-jackets', parentId: null });
    });

    it('suffixes the slug when the name repeats', async () => {
      await post('/admin/categories', { name: 'Scarves' }).expect(201);
      const second = await post('/admin/categories', { name: 'Scarves' }).expect(201);
      expect(second.body.slug).toBe('scarves-2');
    });

    it('creates a sub-category, and rejects an unknown parent', async () => {
      const parent = await prisma.category.findUniqueOrThrow({ where: { slug: 'men' } });
      const res = await post('/admin/categories', { name: 'Shorts', parentId: parent.id }).expect(201);
      expect(res.body.parentId).toBe(parent.id);
      await post('/admin/categories', { name: 'Orphan', parentId: 'nope' }).expect(404);
    });

    it('validates the name', async () => {
      await post('/admin/categories', { name: 'x' }).expect(400);
      await post('/admin/categories', {}).expect(400);
    });

    it('renames a category', async () => {
      const c = (await post('/admin/categories', { name: 'Old Name' }).expect(201)).body;
      const res = await patch(`/admin/categories/${c.id}`, { name: 'New Name' }).expect(200);
      expect(res.body.name).toBe('New Name');
    });

    it('refuses to move a category under itself or its own descendant', async () => {
      const men = await prisma.category.findUniqueOrThrow({ where: { slug: 'men' } });
      const tshirts = await prisma.category.findUniqueOrThrow({ where: { slug: 't-shirts' } });
      await patch(`/admin/categories/${men.id}`, { parentId: men.id }).expect(400);
      await patch(`/admin/categories/${men.id}`, { parentId: tshirts.id }).expect(400);
    });

    it('returns 404 when editing or deleting an unknown category', async () => {
      await patch('/admin/categories/nope', { name: 'Whatever' }).expect(404);
      await del('/admin/categories/nope').expect(404);
    });

    it('deletes an empty category but not one with products or children', async () => {
      const empty = (await post('/admin/categories', { name: 'Empty One' }).expect(201)).body;
      await del(`/admin/categories/${empty.id}`).expect(204);

      const women = await prisma.category.findUniqueOrThrow({ where: { slug: 'women' } }); // has a child
      await del(`/admin/categories/${women.id}`).expect(409);
      await del(`/admin/categories/${categoryId}`).expect(409); // has products
    });
  });

  describe('products', () => {
    it('creates a DRAFT product with slug, GST data and minPrice from the cheapest variant', async () => {
      const p = await newProduct({
        title: 'Create Check Hoodie',
        variants: [variant({ price: 120000 }), variant({ price: 110000, attributes: { size: 'L' } })],
      });
      expect(p).toMatchObject({
        status: 'DRAFT', slug: 'create-check-hoodie', hsnCode: '6110', gstRate: 12, minPrice: 110000,
      });
      expect(p.variants).toHaveLength(2);
    });

    it('defaults GST to 18%', async () => {
      const p = await newProduct({ title: 'Default Gst', gstRate: undefined, hsnCode: undefined });
      expect(p.gstRate).toBe(18);
    });

    it('gives products with the same title distinct slugs', async () => {
      const a = await newProduct({ title: 'Twin Product' });
      const b = await newProduct({ title: 'Twin Product' });
      expect([a.slug, b.slug]).toEqual(['twin-product', 'twin-product-2']);
    });

    it('ignores client-supplied minPrice (computed server side)', async () => {
      const p = await newProduct({ title: 'Mass Assignment', minPrice: 1, variants: [variant({ price: 90000 })] });
      expect(p.minPrice).toBe(90000);
    });

    describe('validation', () => {
      it.each([
        ['price above mrp', { variants: [{ sku: 'V-1', mrp: 1000, price: 2000, attributes: { size: 'M' } }] }],
        ['no variants', { variants: [] }],
        ['gst rate not an Indian slab', { gstRate: 7 }],
        ['hsn code with letters', { hsnCode: 'ABCD' }],
        ['unknown category', { categoryId: 'nope' }],
        ['price in rupees with decimals', { variants: [{ sku: 'V-2', mrp: 999.5, price: 499.5, attributes: {} }] }],
        ['zero price', { variants: [{ sku: 'V-3', mrp: 100, price: 0, attributes: {} }] }],
        ['too-short title', { title: 'x' }],
        ['duplicate SKUs in one request', { variants: [variant({ sku: 'DUP-1' }), variant({ sku: 'DUP-1' })] }],
      ])('rejects %s', async (_label, over) => {
        const body = {
          title: 'Invalid Product', description: 'Valid description', categoryId, variants: [variant()], ...over,
        };
        await post('/admin/products', body).expect(400);
      });

      it('rejects a SKU that already exists (409) and does not create a partial product', async () => {
        await newProduct({ title: 'Sku Owner', variants: [variant({ sku: 'TAKEN-1' })] });
        const before = await prisma.product.count();
        await post('/admin/products', {
          title: 'Sku Thief', description: 'Valid description', categoryId, variants: [variant({ sku: 'TAKEN-1' })],
        }).expect(409);
        expect(await prisma.product.count()).toBe(before);
      });
    });

    it('reads one product with variants, stock and images', async () => {
      const p = await newProduct({ title: 'Read Me' });
      const res = await get(`/admin/products/${p.id}`).expect(200);
      expect(res.body).toMatchObject({ id: p.id, title: 'Read Me' });
      expect(res.body.variants[0]).toHaveProperty('stock');
      expect(res.body).toHaveProperty('images');
      await get('/admin/products/nope').expect(404);
    });

    it('updates fields and publishes; the public API only shows it once ACTIVE', async () => {
      const p = await newProduct({ title: 'Publish Me' });
      await publicGet('/products/publish-me').expect(404);

      const res = await patch(`/admin/products/${p.id}`, { description: 'Updated text', status: 'ACTIVE' }).expect(200);
      expect(res.body).toMatchObject({ description: 'Updated text', status: 'ACTIVE' });
      await publicGet('/products/publish-me').expect(200);
    });

    it('keeps the slug stable when the title changes', async () => {
      const p = await newProduct({ title: 'Stable Slug' });
      const res = await patch(`/admin/products/${p.id}`, { title: 'Renamed Product' }).expect(200);
      expect(res.body).toMatchObject({ title: 'Renamed Product', slug: 'stable-slug' });
    });

    it('rejects invalid updates and unknown products', async () => {
      const p = await newProduct({ title: 'Bad Update' });
      await patch(`/admin/products/${p.id}`, { gstRate: 7 }).expect(400);
      await patch(`/admin/products/${p.id}`, { status: 'DELETED' }).expect(400);
      await patch(`/admin/products/${p.id}`, { categoryId: 'nope' }).expect(400);
      await patch('/admin/products/nope', { title: 'Whatever' }).expect(404);
    });

    it('archives instead of deleting; archived products vanish from the shop but stay in admin', async () => {
      const p = await newProduct({ title: 'Archive Me', status: 'ACTIVE' });
      await publicGet('/products/archive-me').expect(200);

      await del(`/admin/products/${p.id}`).expect(204);
      await publicGet('/products/archive-me').expect(404);
      expect(await prisma.product.findUnique({ where: { id: p.id } })).toMatchObject({ status: 'ARCHIVED' });

      const archived = await get('/admin/products?status=ARCHIVED&search=archive+me').expect(200);
      expect(archived.body.items.map((i: any) => i.slug)).toContain('archive-me');
      await del('/admin/products/nope').expect(404);
    });

    it('lists drafts and active products for admin, and filters by status', async () => {
      await newProduct({ title: 'Admin List Draft' });
      const all = await get('/admin/products?search=admin+list').expect(200);
      expect(all.body.items.map((i: any) => i.status)).toContain('DRAFT');
      const active = await get('/admin/products?status=ACTIVE&search=admin+list').expect(200);
      expect(active.body.total).toBe(0);
    });
  });

  describe('variants', () => {
    const minPriceOf = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).minPrice;

    it('adds a variant and lowers minPrice when it is cheaper', async () => {
      const p = await newProduct({ title: 'Variant Add', variants: [variant({ price: 120000 })] });
      const res = await post(`/admin/products/${p.id}/variants`, variant({ price: 99900, attributes: { size: 'XL' } })).expect(201);
      expect(res.body).toMatchObject({ price: 99900, productId: p.id });
      expect(await minPriceOf(p.id)).toBe(99900);
    });

    it('re-syncs minPrice when a price is edited', async () => {
      const p = await newProduct({
        title: 'Variant Edit', variants: [variant({ price: 100000 }), variant({ price: 90000, attributes: { size: 'L' } })],
      });
      const cheap = p.variants.find((v: any) => v.price === 90000);
      await patch(`/admin/variants/${cheap.id}`, { price: 130000 }).expect(200);
      expect(await minPriceOf(p.id)).toBe(100000);
    });

    it('checks price against the existing mrp when only price is sent', async () => {
      const p = await newProduct({ title: 'Variant Mrp', variants: [variant({ mrp: 100000, price: 80000 })] });
      await patch(`/admin/variants/${p.variants[0].id}`, { price: 100001 }).expect(400);
      await patch(`/admin/variants/${p.variants[0].id}`, { price: 100000 }).expect(200);
    });

    it('rejects a duplicate SKU on add and edit', async () => {
      const a = await newProduct({ title: 'Sku A', variants: [variant({ sku: 'SKU-A' })] });
      const b = await newProduct({ title: 'Sku B', variants: [variant({ sku: 'SKU-B' })] });
      await post(`/admin/products/${a.id}/variants`, variant({ sku: 'SKU-B' })).expect(409);
      await patch(`/admin/variants/${b.variants[0].id}`, { sku: 'SKU-A' }).expect(409);
    });

    it('deletes a variant and re-syncs minPrice', async () => {
      const p = await newProduct({
        title: 'Variant Delete', variants: [variant({ price: 120000 }), variant({ price: 80000, attributes: { size: 'S' } })],
      });
      const cheap = p.variants.find((v: any) => v.price === 80000);
      await del(`/admin/variants/${cheap.id}`).expect(204);
      expect(await minPriceOf(p.id)).toBe(120000);
    });

    it('refuses to delete the last variant of a product', async () => {
      const p = await newProduct({ title: 'Last Variant' });
      await del(`/admin/variants/${p.variants[0].id}`).expect(400);
    });

    it('refuses to delete a variant that is part of an order (409)', async () => {
      const p = await newProduct({
        title: 'Ordered Variant', variants: [variant(), variant({ attributes: { size: 'L' } })],
      });
      const ordered = p.variants[0];
      const user = await prisma.user.create({ data: { name: 'Buyer', email: 'buyer@example.com', passwordHash: 'x' } });
      await prisma.order.create({
        data: {
          userId: user.id, paymentMethod: 'ONLINE', subtotal: ordered.price, total: ordered.price,
          shippingAddress: {},
          items: { create: [{ variantId: ordered.id, title: p.title, sku: ordered.sku, gstRate: 12, unitPrice: ordered.price, quantity: 1 }] },
        },
      });
      await del(`/admin/variants/${ordered.id}`).expect(409);
    });

    it('returns 404 for unknown product or variant ids', async () => {
      await post('/admin/products/nope/variants', variant()).expect(404);
      await patch('/admin/variants/nope', { price: 1000 }).expect(404);
      await del('/admin/variants/nope').expect(404);
    });
  });

  describe('images', () => {
    const upload = (productId: string, file: Buffer | null, opts: { filename: string; contentType: string } = { filename: 'photo.png', contentType: 'image/png' }) => {
      const req = asAdmin(http().post(`/api/v1/admin/products/${productId}/images`));
      return file ? req.attach('file', file, opts) : req.field('note', 'no file here');
    };
    const header = (bytes: number[], total = 64) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(total - bytes.length)]);
    const fileOnDisk = (url: string) => join(process.env.UPLOADS_DIR!, url.replace('/uploads/', ''));

    it('uploads a PNG, stores it under the product, and serves it with cross-origin headers', async () => {
      const p = await newProduct({ title: 'Image Product' });
      const res = await upload(p.id, TINY_PNG).expect(201);
      expect(res.body).toMatchObject({ productId: p.id, position: 0 });
      expect(res.body.url).toMatch(new RegExp(`^/uploads/products/${p.id}/[0-9a-f]{24}\\.png$`));

      const served = await http().get(res.body.url).expect(200);
      expect(served.headers['content-type']).toContain('image/png');
      expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });

    it('numbers images in upload order, and lists them in the public product', async () => {
      const p = await newProduct({ title: 'Two Images', status: 'ACTIVE' });
      const first = await upload(p.id, TINY_PNG).expect(201);
      const second = await upload(p.id, TINY_PNG).expect(201);
      expect([first.body.position, second.body.position]).toEqual([0, 1]);

      const detail = await publicGet('/products/two-images').expect(200);
      expect(detail.body.images.map((i: any) => i.url)).toEqual([first.body.url, second.body.url]);
      const list = await publicGet('/products?search=two+images').expect(200);
      expect(list.body.items[0].image).toBe(first.body.url);
    });

    it('accepts JPEG and WebP by content', async () => {
      const p = await newProduct({ title: 'Other Formats' });
      const jpg = await upload(p.id, header([0xff, 0xd8, 0xff, 0xe0]), { filename: 'a.jpg', contentType: 'image/jpeg' }).expect(201);
      const webp = await upload(
        p.id, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]),
        { filename: 'a.webp', contentType: 'image/webp' },
      ).expect(201);
      expect(jpg.body.url).toMatch(/\.jpg$/);
      expect(webp.body.url).toMatch(/\.webp$/);
    });

    it('trusts file content, not the filename or declared type', async () => {
      const p = await newProduct({ title: 'Disguised Files' });
      await upload(p.id, Buffer.from('<script>alert(1)</script>'), { filename: 'evil.png', contentType: 'image/png' }).expect(415);
      await upload(p.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { filename: 'x.svg', contentType: 'image/svg+xml' }).expect(415);
      // A real PNG uploaded as ".exe" is still stored as a png, never with the client's extension.
      const ok = await upload(p.id, TINY_PNG, { filename: 'virus.exe', contentType: 'application/octet-stream' }).expect(201);
      expect(ok.body.url).toMatch(/\.png$/);
      expect(await prisma.productImage.count({ where: { productId: p.id } })).toBe(1);
    });

    it('rejects files over 5 MB (413)', async () => {
      const p = await newProduct({ title: 'Huge Image' });
      await upload(p.id, Buffer.concat([TINY_PNG, Buffer.alloc(5 * 1024 * 1024 + 1)])).expect(413);
    });

    it('rejects a request without a file (400) and an unknown product (404)', async () => {
      const p = await newProduct({ title: 'No File' });
      await upload(p.id, null).expect(400);
      await upload('nope', TINY_PNG).expect(404);
    });

    it('deletes the record and the file, then the URL returns 404', async () => {
      const p = await newProduct({ title: 'Delete Image' });
      const img = (await upload(p.id, TINY_PNG).expect(201)).body;
      expect(existsSync(fileOnDisk(img.url))).toBe(true);

      await del(`/admin/images/${img.id}`).expect(204);
      expect(existsSync(fileOnDisk(img.url))).toBe(false);
      expect(await prisma.productImage.count({ where: { id: img.id } })).toBe(0);
      await http().get(img.url).expect(404);
      await del(`/admin/images/${img.id}`).expect(404);
    });
  });
});
