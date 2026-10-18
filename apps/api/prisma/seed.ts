// Sample data for local development. Safe to re-run: does nothing if products already exist.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if ((await prisma.product.count()) > 0) {
    console.log('Products already exist, skipping seed.');
    return;
  }

  const location = await prisma.location.create({
    data: { name: 'KOMA Store, Dehradun', isStore: true, address: 'Rajpur Road, Dehradun', pincode: '248001' },
  });

  const men = await prisma.category.create({ data: { name: 'Men', slug: 'men' } });
  const women = await prisma.category.create({ data: { name: 'Women', slug: 'women' } });
  const tshirts = await prisma.category.create({ data: { name: 'T-Shirts', slug: 't-shirts', parentId: men.id } });
  const kurtas = await prisma.category.create({ data: { name: 'Kurtas', slug: 'kurtas', parentId: women.id } });

  const items = [
    { title: 'Classic Cotton T-Shirt', slug: 'classic-cotton-t-shirt', cat: tshirts.id, brand: 'KOMA', gst: 5, mrp: 79900, price: 59900,
      desc: 'Soft 100% cotton crew-neck t-shirt with a regular fit.' },
    { title: 'Graphic Print T-Shirt', slug: 'graphic-print-t-shirt', cat: tshirts.id, brand: 'KOMA', gst: 5, mrp: 99900, price: 74900,
      desc: 'Relaxed-fit tee with a printed graphic on the front.' },
    { title: 'Embroidered Cotton Kurta', slug: 'embroidered-cotton-kurta', cat: kurtas.id, brand: 'KOMA', gst: 5, mrp: 249900, price: 189900,
      desc: 'Straight-cut cotton kurta with hand-finished embroidery at the neckline.' },
  ];

  let n = 1;
  for (const it of items) {
    const sizes = ['S', 'M', 'L'];
    const product = await prisma.product.create({
      data: {
        title: it.title, slug: it.slug, description: it.desc, brand: it.brand, hsnCode: '6109',
        gstRate: it.gst, status: 'ACTIVE', categoryId: it.cat, minPrice: it.price,
        variants: {
          create: sizes.map((size) => ({
            sku: `KOMA-${String(n).padStart(3, '0')}-${size}`, mrp: it.mrp, price: it.price, attributes: { size },
          })),
        },
      },
      include: { variants: true },
    });
    n++;
    // Stock for S and M only, so the storefront also shows an out-of-stock size.
    for (const v of product.variants.filter((v) => (v.attributes as { size: string }).size !== 'L')) {
      await prisma.stockLevel.create({ data: { variantId: v.id, locationId: location.id, onHand: 10 } });
    }
  }
  console.log('Seeded 4 categories, 3 products, 1 location.');
}

main().finally(() => prisma.$disconnect());
