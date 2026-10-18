// Prepares the browser-test database: creates it if needed, applies migrations, wipes it, adds sample data.
// Run by the Playwright config before the API starts. Never touches your development database.
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { join } from 'path';

const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://koma:koma@localhost:5433/koma_e2e?schema=public';

async function main() {
  const url = new URL(DB_URL);
  const dbName = url.pathname.slice(1);
  if (!/(test|e2e)/.test(dbName)) throw new Error(`Refusing to wipe database "${dbName}": name must contain "test" or "e2e"`);

  const adminUrl = new URL(DB_URL);
  adminUrl.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const found = await admin.$queryRaw<unknown[]>`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (found.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.$disconnect();
  }

  execSync('pnpm exec prisma migrate deploy', {
    cwd: join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: 'pipe',
  });

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  try {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);

    const shop = await prisma.location.create({
      data: { name: 'KOMA Store, Dehradun', address: 'Rajpur Road, Dehradun', pincode: '248001' },
    });
    const category = await prisma.category.create({ data: { name: 'T-Shirts', slug: 't-shirts' } });

    // "E2E Tee": sizes S and M in stock, L sold out. Rs 599 incl. 5% GST, so delivery (Rs 50) applies.
    const tee = await prisma.product.create({
      data: {
        title: 'E2E Tee', slug: 'e2e-tee', description: 'A plain cotton tee used by the browser tests.',
        brand: 'KOMA', hsnCode: '6109', gstRate: 5, status: 'ACTIVE', categoryId: category.id, minPrice: 59900,
        variants: {
          create: ['S', 'M', 'L'].map((size) => ({
            sku: `E2E-${size}`, mrp: 79900, price: 59900, attributes: { size },
          })),
        },
      },
      include: { variants: true },
    });
    for (const v of tee.variants.filter((v) => (v.attributes as { size: string }).size !== 'L')) {
      await prisma.stockLevel.create({ data: { variantId: v.id, locationId: shop.id, onHand: 100 } });
    }
    console.log('E2E database ready.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
