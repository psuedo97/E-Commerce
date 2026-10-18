import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  adminToken, createLocation, createTestApp, createVariant, registerCustomer, resetDb, setStock, staffToken,
} from './helpers';

describe('Inventory (admin API)', () => {
  let app: NestExpressApplication;
  let admin: string;
  let staff: string;
  const prisma = new PrismaClient();

  let storeA: { id: string };
  let storeB: { id: string };
  let warehouse: { id: string };

  const http = () => request(app.getHttpServer());
  const as = (token: string, r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const get = (path: string, token = staff) => as(token, http().get(`/api/v1${path}`));
  const post = (path: string, body?: object, token = staff) => as(token, http().post(`/api/v1${path}`)).send(body);
  const patch = (path: string, body: object, token = admin) => as(token, http().patch(`/api/v1${path}`)).send(body);

  const level = (variantId: string, locationId: string) =>
    prisma.stockLevel.findUnique({ where: { variantId_locationId: { variantId, locationId } } });

  beforeAll(async () => {
    await resetDb(prisma);
    app = await createTestApp();
    admin = await adminToken(app, prisma);
    staff = await staffToken(app, prisma);
    storeA = await createLocation(prisma, 'Store A');
    storeB = await createLocation(prisma, 'Store B');
    warehouse = await createLocation(prisma, 'Warehouse', { isStore: false });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('access control', () => {
    const routes: [string, string][] = [
      ['get', '/admin/locations'], ['post', '/admin/locations'], ['patch', '/admin/locations/x'],
      ['get', '/admin/inventory'], ['get', '/admin/inventory/barcode/x'], ['get', '/admin/inventory/movements'],
      ['post', '/admin/inventory/receive'], ['post', '/admin/inventory/adjust'],
      ['post', '/admin/inventory/count'], ['post', '/admin/inventory/transfer'],
    ];

    it.each(routes)('%s %s requires a token (401)', async (method, path) => {
      await (http() as any)[method](`/api/v1${path}`).expect(401);
    });

    it.each(routes)('%s %s is forbidden for customers (403)', async (method, path) => {
      const customer = await registerCustomer(app);
      await (http() as any)[method](`/api/v1${path}`).set('Authorization', `Bearer ${customer}`).expect(403);
    });

    it('lets store staff manage stock', async () => {
      const v = await createVariant(prisma);
      await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 1 }, staff).expect(201);
      await get('/admin/inventory', staff).expect(200);
      await get('/admin/locations', staff).expect(200);
    });

    it('lets only admins create or edit locations', async () => {
      const body = { name: 'Staff Shop', address: '1 Main Road', pincode: '248001' };
      await post('/admin/locations', body, staff).expect(403);
      await patch('/admin/locations/x', { name: 'Nope Nope' }, staff).expect(403);
      await post('/admin/locations', body, admin).expect(201);
    });
  });

  describe('locations', () => {
    it('creates a store by default, active', async () => {
      const res = await post('/admin/locations', { name: 'Dehradun Main', address: 'Rajpur Road', pincode: '248001' }, admin).expect(201);
      expect(res.body).toMatchObject({ name: 'Dehradun Main', isStore: true, active: true, pincode: '248001' });
    });

    it('can create a warehouse', async () => {
      const res = await post('/admin/locations', { name: 'Back Warehouse', address: 'Industrial Area', pincode: '248002', isStore: false }, admin).expect(201);
      expect(res.body.isStore).toBe(false);
    });

    it.each([
      ['short pincode', { pincode: '2480' }],
      ['pincode starting with 0', { pincode: '048001' }],
      ['letters in pincode', { pincode: '24800A' }],
      ['one-letter name', { name: 'X' }],
      ['missing address', { address: undefined }],
    ])('rejects %s', async (_l, over: Record<string, unknown>) => {
      await post('/admin/locations', { name: 'Valid Name', address: '1 Main Road', pincode: '248001', ...over }, admin).expect(400);
    });

    it('lists active locations first', async () => {
      const loc = (await post('/admin/locations', { name: 'Zzz Closed', address: '1 Main Road', pincode: '248001' }, admin).expect(201)).body;
      await patch(`/admin/locations/${loc.id}`, { active: false }).expect(200);
      const res = await get('/admin/locations').expect(200);
      const flags = res.body.map((l: any) => l.active);
      expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
      expect(res.body.find((l: any) => l.id === loc.id).active).toBe(false);
    });

    it('edits and deactivates, 404 for unknown', async () => {
      const loc = (await post('/admin/locations', { name: 'Edit Me', address: '1 Main Road', pincode: '248001' }, admin).expect(201)).body;
      const res = await patch(`/admin/locations/${loc.id}`, { name: 'Edited', pincode: '110001' }).expect(200);
      expect(res.body).toMatchObject({ name: 'Edited', pincode: '110001' });
      await patch('/admin/locations/nope', { name: 'Whatever' }).expect(404);
    });
  });

  describe('receive', () => {
    it('creates the stock record, logs a RECEIVE movement with who, how many and the balance', async () => {
      const v = await createVariant(prisma);
      const res = await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 12, note: 'Supplier delivery' }).expect(201);
      expect(res.body).toMatchObject({ onHand: 12, reserved: 0, available: 12 });

      const [m] = await prisma.stockMovement.findMany({ where: { variantId: v.id } });
      const user = await prisma.user.findFirstOrThrow({ where: { role: 'STAFF' } });
      expect(m).toMatchObject({
        type: 'RECEIVE', quantity: 12, balanceAfter: 12, note: 'Supplier delivery', locationId: storeA.id, userId: user.id,
      });
    });

    it('accumulates across receipts', async () => {
      const v = await createVariant(prisma);
      await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 5 }).expect(201);
      const res = await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 7 }).expect(201);
      expect(res.body.onHand).toBe(12);
      const balances = (await prisma.stockMovement.findMany({ where: { variantId: v.id }, orderBy: { createdAt: 'asc' } })).map((m) => m.balanceAfter);
      expect(balances).toEqual([5, 12]);
    });

    it('keeps each location separate', async () => {
      const v = await createVariant(prisma);
      await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 3 }).expect(201);
      await post('/admin/inventory/receive', { variantId: v.id, locationId: warehouse.id, quantity: 20 }).expect(201);
      expect((await level(v.id, storeA.id))?.onHand).toBe(3);
      expect((await level(v.id, warehouse.id))?.onHand).toBe(20);
    });

    it('finds the variant by barcode or SKU, as when scanning in the shop', async () => {
      const v = await createVariant(prisma, { sku: 'SCAN-SKU-1', barcode: '8901234567890' });
      await post('/admin/inventory/receive', { code: '8901234567890', locationId: storeA.id, quantity: 2 }).expect(201);
      await post('/admin/inventory/receive', { code: 'SCAN-SKU-1', locationId: storeA.id, quantity: 3 }).expect(201);
      expect((await level(v.id, storeA.id))?.onHand).toBe(5);
    });

    it.each([
      ['zero quantity', { quantity: 0 }],
      ['negative quantity', { quantity: -3 }],
      ['fractional quantity', { quantity: 1.5 }],
      ['absurd quantity', { quantity: 1_000_000 }],
      ['string quantity', { quantity: 'ten' }],
    ])('rejects %s', async (_l, over: Record<string, unknown>) => {
      const v = await createVariant(prisma);
      await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 1, ...over }).expect(400);
      expect(await level(v.id, storeA.id)).toBeNull();
    });

    it('needs a variant reference, and 404s for unknown variant or location', async () => {
      const v = await createVariant(prisma);
      await post('/admin/inventory/receive', { locationId: storeA.id, quantity: 1 }).expect(400);
      await post('/admin/inventory/receive', { variantId: 'nope', locationId: storeA.id, quantity: 1 }).expect(404);
      await post('/admin/inventory/receive', { code: 'no-such-code', locationId: storeA.id, quantity: 1 }).expect(404);
      await post('/admin/inventory/receive', { variantId: v.id, locationId: 'nope', quantity: 1 }).expect(404);
    });

    it('will not receive into an inactive location', async () => {
      const v = await createVariant(prisma);
      const closed = await createLocation(prisma, 'Closed Shop', { active: false });
      await post('/admin/inventory/receive', { variantId: v.id, locationId: closed.id, quantity: 1 }).expect(409);
    });
  });

  describe('adjust', () => {
    it('adds found stock and logs a signed movement with the reason', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 4);
      const res = await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: 3, reason: 'FOUND' }).expect(201);
      expect(res.body.onHand).toBe(7);
      const m = await prisma.stockMovement.findFirstOrThrow({ where: { variantId: v.id } });
      expect(m).toMatchObject({ type: 'ADJUSTMENT', quantity: 3, balanceAfter: 7, reason: 'FOUND' });
    });

    it('removes damaged stock', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const res = await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: -4, reason: 'DAMAGED', note: 'Water damage' }).expect(201);
      expect(res.body).toMatchObject({ onHand: 6, available: 6 });
      const m = await prisma.stockMovement.findFirstOrThrow({ where: { variantId: v.id } });
      expect(m).toMatchObject({ quantity: -4, balanceAfter: 6, reason: 'DAMAGED', note: 'Water damage' });
    });

    it('can remove everything that is available, down to zero', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 3);
      const res = await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: -3, reason: 'LOST' }).expect(201);
      expect(res.body.onHand).toBe(0);
    });

    it('refuses to go below zero and changes nothing', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 3);
      const res = await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: -4, reason: 'LOST' }).expect(409);
      expect(res.body.message).toMatch(/only 3 available/);
      expect((await level(v.id, storeA.id))?.onHand).toBe(3);
      expect(await prisma.stockMovement.count({ where: { variantId: v.id } })).toBe(0);
    });

    it('cannot remove units that are reserved for customer orders', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10, 8); // only 2 free
      const res = await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: -5, reason: 'DAMAGED' }).expect(409);
      expect(res.body.message).toMatch(/only 2 available.*8 reserved/);
      await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: -2, reason: 'DAMAGED' }).expect(201);
    });

    it('cannot remove stock from a location that has none recorded', async () => {
      const v = await createVariant(prisma);
      await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: -1, reason: 'LOST' }).expect(409);
    });

    it.each([
      ['zero delta', { delta: 0 }],
      ['unknown reason', { reason: 'BECAUSE' }],
      ['missing reason', { reason: undefined }],
      ['fractional delta', { delta: 0.5 }],
    ])('rejects %s', async (_l, over: Record<string, unknown>) => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 5);
      await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: 1, reason: 'FOUND', ...over }).expect(400);
    });
  });

  describe('count (stocktake)', () => {
    it('sets on-hand to the counted number and logs the difference', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const res = await post('/admin/inventory/count', { variantId: v.id, locationId: storeA.id, counted: 7, note: 'Monthly count' }).expect(201);
      expect(res.body.onHand).toBe(7);
      const m = await prisma.stockMovement.findFirstOrThrow({ where: { variantId: v.id } });
      expect(m).toMatchObject({ type: 'COUNT', quantity: -3, balanceAfter: 7, note: 'Monthly count' });
    });

    it('logs nothing when the count matches', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      await post('/admin/inventory/count', { variantId: v.id, locationId: storeA.id, counted: 10 }).expect(201);
      expect(await prisma.stockMovement.count({ where: { variantId: v.id } })).toBe(0);
    });

    it('creates the record when counting something never stocked here', async () => {
      const v = await createVariant(prisma);
      const res = await post('/admin/inventory/count', { variantId: v.id, locationId: storeB.id, counted: 6 }).expect(201);
      expect(res.body.onHand).toBe(6);
      const m = await prisma.stockMovement.findFirstOrThrow({ where: { variantId: v.id } });
      expect(m).toMatchObject({ quantity: 6, balanceAfter: 6 });
    });

    it('cannot count below the units reserved for orders', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10, 4);
      await post('/admin/inventory/count', { variantId: v.id, locationId: storeA.id, counted: 3 }).expect(409);
      expect((await level(v.id, storeA.id))?.onHand).toBe(10);
      await post('/admin/inventory/count', { variantId: v.id, locationId: storeA.id, counted: 4 }).expect(201);
    });

    it('rejects a negative count', async () => {
      const v = await createVariant(prisma);
      await post('/admin/inventory/count', { variantId: v.id, locationId: storeA.id, counted: -1 }).expect(400);
    });
  });

  describe('transfer', () => {
    it('moves stock between locations and logs both sides', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, warehouse.id, 20);
      const res = await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: warehouse.id, toLocationId: storeA.id, quantity: 8 }).expect(201);
      expect(res.body.from).toMatchObject({ locationId: warehouse.id, onHand: 12 });
      expect(res.body.to).toMatchObject({ locationId: storeA.id, onHand: 8 });

      const moves = await prisma.stockMovement.findMany({ where: { variantId: v.id }, orderBy: { type: 'asc' } });
      expect(moves.map((m) => [m.type, m.locationId, m.quantity, m.balanceAfter])).toEqual([
        ['TRANSFER_OUT', warehouse.id, -8, 12],
        ['TRANSFER_IN', storeA.id, 8, 8],
      ]);
    });

    it('fails as a whole when the source has too little (nothing moves, nothing is logged)', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, warehouse.id, 5);
      await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: warehouse.id, toLocationId: storeA.id, quantity: 6 }).expect(409);
      expect((await level(v.id, warehouse.id))?.onHand).toBe(5);
      expect(await level(v.id, storeA.id)).toBeNull();
      expect(await prisma.stockMovement.count({ where: { variantId: v.id } })).toBe(0);
    });

    it('cannot transfer units that are reserved', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, warehouse.id, 10, 7);
      await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: warehouse.id, toLocationId: storeA.id, quantity: 4 }).expect(409);
      await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: warehouse.id, toLocationId: storeA.id, quantity: 3 }).expect(201);
    });

    it('rejects same source and destination, and unknown locations', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, warehouse.id, 5);
      await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: warehouse.id, toLocationId: warehouse.id, quantity: 1 }).expect(400);
      await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: 'nope', toLocationId: storeA.id, quantity: 1 }).expect(404);
      await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: warehouse.id, toLocationId: 'nope', quantity: 1 }).expect(404);
    });

    it('can empty an inactive location into an active one, but not the other way round', async () => {
      const v = await createVariant(prisma);
      const closed = await createLocation(prisma, 'Closing Shop', { active: false });
      await setStock(prisma, v.id, closed.id, 5);
      await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: closed.id, toLocationId: storeA.id, quantity: 5 }).expect(201);
      await post('/admin/inventory/transfer', { variantId: v.id, fromLocationId: storeA.id, toLocationId: closed.id, quantity: 1 }).expect(409);
    });
  });

  describe('stock list', () => {
    it('shows per-location and total on-hand, reserved and available', async () => {
      const v = await createVariant(prisma, { sku: 'LIST-TOTALS' });
      await setStock(prisma, v.id, storeA.id, 10, 3);
      await setStock(prisma, v.id, warehouse.id, 5, 0);
      const res = await get('/admin/inventory?search=LIST-TOTALS').expect(200);
      expect(res.body.total).toBe(1);
      const item = res.body.items[0];
      expect(item).toMatchObject({ variantId: v.id, sku: 'LIST-TOTALS', onHand: 15, reserved: 3, available: 12 });
      expect(item.locations.map((l: any) => [l.name, l.onHand, l.reserved, l.available]).sort()).toEqual([
        ['Store A', 10, 3, 7], ['Warehouse', 5, 0, 5],
      ]);
    });

    it('leaves inactive locations out of the totals but still lists them', async () => {
      const v = await createVariant(prisma, { sku: 'LIST-INACTIVE' });
      const closed = await createLocation(prisma, 'Dormant', { active: false });
      await setStock(prisma, v.id, storeA.id, 4);
      await setStock(prisma, v.id, closed.id, 100);
      const item = (await get('/admin/inventory?search=LIST-INACTIVE').expect(200)).body.items[0];
      expect(item.available).toBe(4);
      expect(item.locations.find((l: any) => l.name === 'Dormant')).toMatchObject({ active: false, onHand: 100 });
    });

    it('searches by SKU, barcode and product title', async () => {
      await createVariant(prisma, { sku: 'FIND-ME-SKU', barcode: '5551230001', title: 'Findable Jacket' });
      for (const term of ['find-me-sku', '5551230001', 'findable jacket']) {
        const res = await get(`/admin/inventory?search=${encodeURIComponent(term)}`).expect(200);
        expect(res.body.items.map((i: any) => i.sku)).toEqual(['FIND-ME-SKU']);
      }
    });

    it('filters by location', async () => {
      const v = await createVariant(prisma, { sku: 'LOC-FILTER' });
      const only = await createLocation(prisma, 'Only Here');
      await setStock(prisma, v.id, only.id, 2);
      const res = await get(`/admin/inventory?locationId=${only.id}`).expect(200);
      expect(res.body.items.map((i: any) => i.sku)).toEqual(['LOC-FILTER']);
      expect(res.body.items[0].locations).toHaveLength(1);
    });

    it('finds low and out-of-stock variants', async () => {
      const out = await createVariant(prisma, { sku: 'LOW-OUT' });
      const low = await createVariant(prisma, { sku: 'LOW-FEW' });
      const fine = await createVariant(prisma, { sku: 'LOW-FINE' });
      await setStock(prisma, low.id, storeA.id, 3);
      await setStock(prisma, fine.id, storeA.id, 50);
      void out;

      const skus = async (n: number) =>
        (await get(`/admin/inventory?lowStock=${n}&search=LOW-&limit=100`).expect(200)).body.items.map((i: any) => i.sku).sort();
      expect(await skus(0)).toEqual(['LOW-OUT']); // never stocked counts as zero
      expect(await skus(5)).toEqual(['LOW-FEW', 'LOW-OUT']);
      expect(await skus(100)).toEqual(['LOW-FEW', 'LOW-FINE', 'LOW-OUT']);
    });

    it('counts reserved units as unavailable when finding low stock', async () => {
      const v = await createVariant(prisma, { sku: 'RSV-LOW' });
      await setStock(prisma, v.id, storeA.id, 10, 9); // 1 available
      const res = await get('/admin/inventory?lowStock=2&search=RSV-LOW').expect(200);
      expect(res.body.items).toHaveLength(1);
    });

    it('paginates and validates the query', async () => {
      const res = await get('/admin/inventory?limit=2&page=1').expect(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.totalPages).toBeGreaterThan(1);
      await get('/admin/inventory?limit=500').expect(400);
      await get('/admin/inventory?lowStock=-1').expect(400);
      await get('/admin/inventory?page=0').expect(400);
    });
  });

  describe('barcode lookup', () => {
    it('finds a variant by barcode or SKU with its stock', async () => {
      const v = await createVariant(prisma, { sku: 'BC-SKU', barcode: '9990001112223' });
      await setStock(prisma, v.id, storeA.id, 6, 1);
      for (const code of ['9990001112223', 'BC-SKU']) {
        const res = await get(`/admin/inventory/barcode/${code}`).expect(200);
        expect(res.body).toMatchObject({ variantId: v.id, sku: 'BC-SKU', barcode: '9990001112223', onHand: 6, reserved: 1, available: 5 });
        expect(res.body.product).toMatchObject({ slug: v.productSlug, status: 'ACTIVE' });
      }
    });

    it('returns 404 for an unknown code', async () => {
      await get('/admin/inventory/barcode/0000000000000').expect(404);
    });
  });

  describe('movement history', () => {
    it('lists changes newest first, with SKU and location name', async () => {
      const v = await createVariant(prisma, { sku: 'HIST-1' });
      await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 10 }).expect(201);
      await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: -2, reason: 'DAMAGED' }).expect(201);
      await post('/admin/inventory/count', { variantId: v.id, locationId: storeA.id, counted: 9 }).expect(201);

      const res = await get(`/admin/inventory/movements?variantId=${v.id}`).expect(200);
      expect(res.body.items.map((m: any) => [m.type, m.quantity, m.balanceAfter])).toEqual([
        ['COUNT', 1, 9], ['ADJUSTMENT', -2, 8], ['RECEIVE', 10, 10],
      ]);
      expect(res.body.items[0]).toMatchObject({ variant: { sku: 'HIST-1' }, location: { name: 'Store A' } });
    });

    it('filters by type and location, and paginates', async () => {
      const v = await createVariant(prisma);
      await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 5 }).expect(201);
      await post('/admin/inventory/receive', { variantId: v.id, locationId: storeB.id, quantity: 5 }).expect(201);
      await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: 1, reason: 'FOUND' }).expect(201);

      const received = await get(`/admin/inventory/movements?variantId=${v.id}&type=RECEIVE`).expect(200);
      expect(received.body.total).toBe(2);
      const atB = await get(`/admin/inventory/movements?variantId=${v.id}&locationId=${storeB.id}`).expect(200);
      expect(atB.body.total).toBe(1);
      const page = await get(`/admin/inventory/movements?variantId=${v.id}&limit=2&page=2`).expect(200);
      expect(page.body).toMatchObject({ total: 3, totalPages: 2 });
      expect(page.body.items).toHaveLength(1);
      await get('/admin/inventory/movements?type=BOGUS').expect(400);
    });
  });

  describe('effect on the storefront', () => {
    const publicVariant = async (slug: string) =>
      (await http().get(`/api/v1/products/${slug}`).expect(200)).body.variants[0];

    it('makes a variant buyable once stock is received, and sold out when removed', async () => {
      const v = await createVariant(prisma);
      expect((await publicVariant(v.productSlug)).inStock).toBe(false);

      await post('/admin/inventory/receive', { variantId: v.id, locationId: storeA.id, quantity: 3 }).expect(201);
      expect(await publicVariant(v.productSlug)).toMatchObject({ inStock: true, lowStock: true });

      await post('/admin/inventory/adjust', { variantId: v.id, locationId: storeA.id, delta: -3, reason: 'LOST' }).expect(201);
      expect((await publicVariant(v.productSlug)).inStock).toBe(false);
    });

    it('sells stock from the shop and the warehouse together', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 4);
      await setStock(prisma, v.id, warehouse.id, 4);
      expect(await publicVariant(v.productSlug)).toMatchObject({ inStock: true, lowStock: false }); // 8 available
    });

    it('ignores stock held in an inactive location', async () => {
      const v = await createVariant(prisma);
      const closed = await createLocation(prisma, 'Shut Down', { active: false });
      await setStock(prisma, v.id, closed.id, 50);
      expect((await publicVariant(v.productSlug)).inStock).toBe(false);
      const list = await http().get('/api/v1/products?search=inventory&limit=48').expect(200);
      const item = list.body.items.find((p: any) => p.slug === v.productSlug);
      expect(item).toBeDefined(); // listed (active product), but not sellable
      expect(item.inStock).toBe(false);
    });

    it('stops showing reserved units as available', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 5, 5);
      expect((await publicVariant(v.productSlug)).inStock).toBe(false);
    });
  });

  describe('database safety net', () => {
    it('refuses negative stock even if application code is bypassed', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 2);
      await expect(
        prisma.$executeRaw`UPDATE "StockLevel" SET "onHand" = -1 WHERE "variantId" = ${v.id}`,
      ).rejects.toThrow();
    });

    it('refuses reserving more than is on hand', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 2);
      await expect(
        prisma.$executeRaw`UPDATE "StockLevel" SET reserved = 3 WHERE "variantId" = ${v.id}`,
      ).rejects.toThrow();
    });
  });
});
