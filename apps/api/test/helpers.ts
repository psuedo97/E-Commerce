import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

export async function createTestApp() {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  return app;
}

export async function resetDb(prisma: PrismaClient) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

let counter = 0;

/** Registers a customer and returns their access token. */
export async function registerCustomer(app: NestExpressApplication) {
  const email = `customer${++counter}@example.com`;
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ name: 'Test Customer', email, password: 'password123' })
    .expect(201);
  return res.body.accessToken as string;
}

/** Registers a user, promotes them to `role` in the DB, then logs in so the token carries the role. */
export async function adminToken(app: NestExpressApplication, prisma: PrismaClient, role: Role = 'ADMIN') {
  const email = `${role.toLowerCase()}${++counter}@example.com`;
  const http = request(app.getHttpServer());
  await http.post('/api/v1/auth/register').send({ name: 'Test Staff', email, password: 'password123' }).expect(201);
  await prisma.user.update({ where: { email }, data: { role } });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: 'password123' })
    .expect(200);
  return res.body.accessToken as string;
}

/** Sample catalog: Men > T-Shirts, Women > Kurtas, three active products. Sizes L have no stock. */
export async function seedCatalog(prisma: PrismaClient) {
  const location = await prisma.location.create({
    data: { name: 'Test Store', address: 'Rajpur Road', pincode: '248001' },
  });
  const men = await prisma.category.create({ data: { name: 'Men', slug: 'men' } });
  const women = await prisma.category.create({ data: { name: 'Women', slug: 'women' } });
  const tshirts = await prisma.category.create({ data: { name: 'T-Shirts', slug: 't-shirts', parentId: men.id } });
  const kurtas = await prisma.category.create({ data: { name: 'Kurtas', slug: 'kurtas', parentId: women.id } });

  const defs = [
    { title: 'Classic Cotton T-Shirt', slug: 'classic-cotton-t-shirt', categoryId: tshirts.id, mrp: 79900, price: 59900, description: 'Soft cotton crew-neck tee.' },
    { title: 'Graphic Print T-Shirt', slug: 'graphic-print-t-shirt', categoryId: tshirts.id, mrp: 99900, price: 74900, description: 'Relaxed fit printed tee.' },
    { title: 'Embroidered Cotton Kurta', slug: 'embroidered-cotton-kurta', categoryId: kurtas.id, mrp: 249900, price: 189900, description: 'Straight kurta with embroidery.' },
  ];
  for (const [i, d] of defs.entries()) {
    const product = await prisma.product.create({
      data: {
        title: d.title, slug: d.slug, description: d.description, brand: 'KOMA', status: 'ACTIVE',
        categoryId: d.categoryId, minPrice: d.price,
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)), // explicit, so "newest" ordering is deterministic
        variants: {
          create: ['S', 'M', 'L'].map((size) => ({
            sku: `SEED-${i + 1}-${size}`, mrp: d.mrp, price: d.price, attributes: { size },
          })),
        },
      },
      include: { variants: true },
    });
    for (const v of product.variants.filter((v) => (v.attributes as { size: string }).size !== 'L')) {
      await prisma.stockLevel.create({ data: { variantId: v.id, locationId: location.id, onHand: 10 } });
    }
  }
  return { location, men, women, tshirts, kurtas };
}

export const staffToken = (app: NestExpressApplication, prisma: PrismaClient) => adminToken(app, prisma, 'STAFF');

/** A product with one variant (no stock yet). Returns the variant. */
export async function createVariant(
  prisma: PrismaClient,
  over: { sku?: string; barcode?: string; title?: string; price?: number; gstRate?: number; hsnCode?: string } = {},
) {
  const n = ++counter;
  const price = over.price ?? 50000;
  const category = await prisma.category.upsert({
    where: { slug: 'inventory-tests' }, update: {}, create: { name: 'Inventory Tests', slug: 'inventory-tests' },
  });
  const product = await prisma.product.create({
    data: {
      title: over.title ?? `Inventory Product ${n}`, slug: `inventory-product-${n}`, description: 'For inventory tests',
      status: 'ACTIVE', categoryId: category.id, minPrice: price,
      gstRate: over.gstRate ?? 18, hsnCode: over.hsnCode,
      variants: {
        create: [{ sku: over.sku ?? `INV-${n}`, barcode: over.barcode, mrp: price + 10000, price, attributes: { size: 'M' } }],
      },
    },
    include: { variants: true },
  });
  return { ...product.variants[0], productSlug: product.slug };
}

export function createLocation(prisma: PrismaClient, name: string, over: { active?: boolean; isStore?: boolean } = {}) {
  return prisma.location.create({ data: { name, address: 'Test address', pincode: '248001', ...over } });
}

/** Puts stock straight into the DB, bypassing the API (for arranging test state). */
export function setStock(prisma: PrismaClient, variantId: string, locationId: string, onHand: number, reserved = 0) {
  return prisma.stockLevel.upsert({
    where: { variantId_locationId: { variantId, locationId } },
    create: { variantId, locationId, onHand, reserved },
    update: { onHand, reserved },
  });
}

/** A minimal order row, needed because reservations and movements point at an order. */
export async function createOrder(prisma: PrismaClient) {
  const user = await prisma.user.create({
    data: { name: 'Buyer', email: `buyer${++counter}@example.com`, passwordHash: 'x' },
  });
  const order = await prisma.order.create({
    data: { userId: user.id, paymentMethod: 'ONLINE', subtotal: 0, total: 0, shippingAddress: {} },
  });
  return order.id;
}

/** Smallest valid PNG (1x1 pixel). */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
