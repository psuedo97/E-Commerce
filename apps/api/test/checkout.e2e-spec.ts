import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { OrdersService } from '../src/orders/orders.service';
import { createLocation, createTestApp, createVariant, registerCustomer, resetDb, setStock } from './helpers';

type Variant = Awaited<ReturnType<typeof createVariant>>;

describe('Checkout and orders', () => {
  let app: NestExpressApplication;
  let shop: { id: string };
  let shopB: { id: string };
  let warehouse: { id: string };
  const prisma = new PrismaClient();

  const http = () => request(app.getHttpServer());
  const call = (method: 'get' | 'post' | 'patch', path: string, token: string) =>
    http()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const shopper = async () => {
    const token = await registerCustomer(app);
    const me = await call('get', '/users/me', token).expect(200);
    return { token, id: me.body.id as string };
  };

  const addAddress = async (token: string, over: Record<string, unknown> = {}) =>
    (await call('post', '/users/me/addresses', token)
      .send({ name: 'Asha Rawat', phone: '9876543210', line1: '12 Rajpur Road', city: 'Dehradun', state: 'Uttarakhand', pincode: '248001', ...over })
      .expect(201)).body.id as string;

  /** A variant with stock at the main shop. Default: Rs 599 at 5% GST. */
  const stocked = async (over: Parameters<typeof createVariant>[1] = {}, onHand = 50) => {
    const v = await createVariant(prisma, { price: 59900, gstRate: 5, hsnCode: '6109', ...over });
    await setStock(prisma, v.id, shop.id, onHand);
    return v;
  };

  const fill = async (token: string, lines: [Variant, number][]) => {
    for (const [v, quantity] of lines) {
      await call('post', '/cart/items', token).send({ variantId: v.id, quantity }).expect(201);
    }
  };

  const level = (variantId: string, locationId: string) =>
    prisma.stockLevel.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } });

  const reservedTotal = async (variantId: string) =>
    (await prisma.stockLevel.findMany({ where: { variantId } })).reduce((n, l) => n + l.reserved, 0);

  const ship = (addressId: string) => ({ fulfilment: 'SHIP', addressId });
  const pickup = (pickupLocationId: string, extra = {}) => ({ fulfilment: 'STORE_PICKUP', pickupLocationId, ...extra });

  beforeAll(async () => {
    await resetDb(prisma);
    app = await createTestApp();
    shop = await createLocation(prisma, 'Main Shop');
    shopB = await createLocation(prisma, 'Second Shop');
    warehouse = await createLocation(prisma, 'Warehouse', { isStore: false });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('access', () => {
    it.each([
      ['post', '/checkout/quote'], ['post', '/checkout'], ['get', '/orders'], ['get', '/orders/x'], ['post', '/orders/x/cancel'],
    ] as const)('%s %s needs a login', async (method, path) => {
      await http()[method](`/api/v1${path}`).expect(401);
    });
  });

  describe('GET /stores (pickup points)', () => {
    it('lists active shops publicly, without warehouses, closed shops or internal fields', async () => {
      await createLocation(prisma, 'Closed Branch', { active: false });
      const res = await http().get('/api/v1/stores').expect(200);
      const names = res.body.map((s: any) => s.name);
      expect(names).toEqual(expect.arrayContaining(['Main Shop', 'Second Shop']));
      expect(names).not.toContain('Warehouse');
      expect(names).not.toContain('Closed Branch');
      expect(Object.keys(res.body[0]).sort()).toEqual(['address', 'id', 'name', 'pincode']);
    });
  });

  describe('shipping serviceability', () => {
    it('says a normal pincode is deliverable', async () => {
      const res = await http().get('/api/v1/shipping/serviceability?pincode=248001').expect(200);
      expect(res.body).toEqual({ pincode: '248001', serviceable: true });
    });

    it('can block pincodes through configuration', async () => {
      process.env.UNSERVICEABLE_PINCODES = '194101, 744101';
      try {
        const res = await http().get('/api/v1/shipping/serviceability?pincode=744101').expect(200);
        expect(res.body.serviceable).toBe(false);
        await http().get('/api/v1/shipping/serviceability?pincode=248001').expect(200).expect((r) => expect(r.body.serviceable).toBe(true));
      } finally {
        delete process.env.UNSERVICEABLE_PINCODES;
      }
    });

    it.each(['', '1234', 'abcdef', '0123456', '12345a'])('rejects the invalid pincode "%s"', async (p) => {
      await http().get(`/api/v1/shipping/serviceability?pincode=${p}`).expect(400);
    });
  });

  describe('quote', () => {
    it('prices a delivery inside Uttarakhand with CGST + SGST, shipping included', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const v = await stocked({ title: 'Quote Tee' });
      await fill(token, [[v, 1]]);

      const res = await call('post', '/checkout/quote', token).send(ship(addressId)).expect(200);

      expect(res.body).toMatchObject({ fulfilment: 'SHIP', subtotal: 59900, shippingFee: 5000, total: 64900 });
      expect(res.body.items[0]).toMatchObject({ title: 'Quote Tee (M)', sku: v.sku, quantity: 1, unitPrice: 59900, lineTotal: 59900, gstRate: 5 });
      expect(res.body.tax).toEqual({
        placeOfSupply: 'Uttarakhand', sellerState: 'Uttarakhand', intraState: true,
        taxableValue: 61285, cgst: 1807, sgst: 1808, igst: 0, totalTax: 3615,
      });
      expect(res.body.stockIssues).toEqual([]);
    });

    it('uses IGST for another state', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token, { state: 'Maharashtra', city: 'Pune', pincode: '411001' });
      const v = await stocked();
      await fill(token, [[v, 1]]);
      const res = await call('post', '/checkout/quote', token).send(ship(addressId)).expect(200);
      expect(res.body.tax).toMatchObject({ placeOfSupply: 'Maharashtra', intraState: false, cgst: 0, sgst: 0, igst: 3615, totalTax: 3615 });
    });

    it('makes delivery free above the threshold', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const v = await stocked();
      await fill(token, [[v, 2]]); // 119800
      const res = await call('post', '/checkout/quote', token).send(ship(addressId)).expect(200);
      expect(res.body).toMatchObject({ subtotal: 119800, shippingFee: 0, total: 119800 });
      expect(res.body.tax).toMatchObject({ taxableValue: 114095, totalTax: 5705, cgst: 2852, sgst: 2853 });
    });

    it('prices store pickup with no shipping and the shop’s state, whatever the customer’s address', async () => {
      const { token } = await shopper();
      await addAddress(token, { state: 'Kerala', city: 'Kochi', pincode: '682001' });
      const v = await stocked();
      await fill(token, [[v, 1]]);
      const res = await call('post', '/checkout/quote', token).send(pickup(shop.id, { contactPhone: '9876500000' })).expect(200);
      expect(res.body).toMatchObject({ subtotal: 59900, shippingFee: 0, total: 59900 });
      expect(res.body.tax).toMatchObject({ intraState: true, taxableValue: 57048, totalTax: 2852, cgst: 1426, sgst: 1426 });
    });

    it('creates nothing and holds no stock', async () => {
      const { token, id } = await shopper();
      const addressId = await addAddress(token);
      const v = await stocked();
      await fill(token, [[v, 2]]);
      await call('post', '/checkout/quote', token).send(ship(addressId)).expect(200);
      expect(await prisma.order.count({ where: { userId: id } })).toBe(0);
      expect(await reservedTotal(v.id)).toBe(0);
      const cart = await call('get', '/cart', token).expect(200);
      expect(cart.body.itemCount).toBe(2); // cart untouched
    });

    it('warns about items that are short on stock', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const v = await stocked({ title: 'Short Tee' }, 10);
      await fill(token, [[v, 3]]);
      await setStock(prisma, v.id, shop.id, 1);
      const res = await call('post', '/checkout/quote', token).send(ship(addressId)).expect(200);
      expect(res.body.stockIssues).toEqual([{ variantId: v.id, title: 'Short Tee (M)', requested: 3, available: 1 }]);
    });
  });

  describe('input checks (quote and checkout behave the same)', () => {
    const both = ['/checkout/quote', '/checkout'] as const;

    it.each(both)('%s rejects an empty cart', async (path) => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const res = await call('post', path, token).send(ship(addressId)).expect(400);
      expect(res.body.message).toBe('Your cart is empty');
    });

    it.each(both)('%s rejects cash on delivery while it is switched off', async (path) => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      await fill(token, [[await stocked(), 1]]);
      const res = await call('post', path, token).send({ ...ship(addressId), paymentMethod: 'COD' }).expect(400);
      expect(res.body.message).toMatch(/Cash on delivery is not available/);
    });

    it.each(both)('%s needs an address for delivery', async (path) => {
      const { token } = await shopper();
      await fill(token, [[await stocked(), 1]]);
      await call('post', path, token).send({ fulfilment: 'SHIP' }).expect(400);
    });

    it.each(both)('%s needs a pickup location for pickup', async (path) => {
      const { token } = await shopper();
      await fill(token, [[await stocked(), 1]]);
      await call('post', path, token).send({ fulfilment: 'STORE_PICKUP' }).expect(400);
    });

    it.each(both)('%s rejects an unknown fulfilment type', async (path) => {
      const { token } = await shopper();
      await call('post', path, token).send({ fulfilment: 'DRONE' }).expect(400);
    });

    it.each(both)('%s treats another customer’s address as not found', async (path) => {
      const owner = await shopper();
      const addressId = await addAddress(owner.token);
      const { token } = await shopper();
      await fill(token, [[await stocked(), 1]]);
      await call('post', path, token).send(ship(addressId)).expect(404);
    });

    it.each(both)('%s refuses delivery to a blocked pincode', async (path) => {
      const { token } = await shopper();
      const addressId = await addAddress(token, { pincode: '744101' });
      await fill(token, [[await stocked(), 1]]);
      process.env.UNSERVICEABLE_PINCODES = '744101';
      try {
        const res = await call('post', path, token).send(ship(addressId)).expect(400);
        expect(res.body.message).toMatch(/do not deliver to pincode 744101/);
      } finally {
        delete process.env.UNSERVICEABLE_PINCODES;
      }
    });

    it.each(both)('%s only accepts an active shop as the pickup point (not a warehouse, closed shop or unknown id)', async (path) => {
      const { token } = await shopper();
      await fill(token, [[await stocked(), 1]]);
      const closed = await createLocation(prisma, 'Closed Shop', { active: false });
      for (const id of [warehouse.id, closed.id, 'nope']) {
        await call('post', path, token).send(pickup(id, { contactPhone: '9876500000' })).expect(404);
      }
    });

    it.each(both)('%s needs a contact phone for pickup, from the request or the profile', async (path) => {
      const { token } = await shopper(); // registered without a phone
      await fill(token, [[await stocked(), 1]]);
      const res = await call('post', path, token).send(pickup(shop.id)).expect(400);
      expect(res.body.message).toMatch(/contact phone/);
      await call('post', path, token).send(pickup(shop.id, { contactPhone: '12345' })).expect(400);
      await call('post', path, token).send(pickup(shop.id, { contactPhone: '9876500000' })).expect(path === '/checkout' ? 201 : 200);
    });

    it('uses the profile phone for pickup when none is given', async () => {
      const { token } = await shopper();
      await call('patch', '/users/me', token).send({ phone: '9811122233' }).expect(200);
      await fill(token, [[await stocked(), 1]]);
      const res = await call('post', '/checkout', token).send(pickup(shop.id)).expect(201);
      expect(res.body.shippingAddress).toMatchObject({ type: 'PICKUP', contactPhone: '9811122233' });
    });

    it('rejects when an item has been archived since it was added', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const v = await stocked({ title: 'Archived Soon' });
      await fill(token, [[v, 1]]);
      await prisma.product.update({ where: { id: v.productId }, data: { status: 'ARCHIVED' } });
      const res = await call('post', '/checkout', token).send(ship(addressId)).expect(409);
      expect(res.body.items).toEqual([{ variantId: v.id, title: 'Archived Soon' }]);
    });
  });

  describe('placing an order', () => {
    it('creates a pending, unpaid order with a full snapshot, holds the stock and empties the cart', async () => {
      const { token, id } = await shopper();
      const addressId = await addAddress(token, { line2: 'Near Clock Tower' });
      const v = await stocked({ title: 'Order Tee', hsnCode: '6109' }, 20);
      await fill(token, [[v, 2]]);

      const res = await call('post', '/checkout', token).send(ship(addressId)).expect(201);
      const o = res.body;

      expect(o).toMatchObject({
        status: 'PENDING', fulfilment: 'SHIP', paymentMethod: 'ONLINE', subtotal: 119800, shippingFee: 0,
        discount: 0, total: 119800, payment: null, pickupLocationId: null,
      });
      expect(o.items).toEqual([{
        variantId: v.id, title: 'Order Tee (M)', sku: v.sku, quantity: 2, unitPrice: 59900, lineTotal: 119800, gstRate: 5,
      }]);
      expect(o.tax).toMatchObject({ intraState: true, totalTax: 5705, cgst: 2852, sgst: 2853 });
      expect(o.shippingAddress).toEqual({
        type: 'SHIP', name: 'Asha Rawat', phone: '9876543210', line1: '12 Rajpur Road', line2: 'Near Clock Tower',
        city: 'Dehradun', state: 'Uttarakhand', pincode: '248001',
      });

      // hold lasts about 30 minutes
      const minutes = (new Date(o.expiresAt).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(29);
      expect(minutes).toBeLessThanOrEqual(30);

      // stock held, not yet sold
      expect(await level(v.id, shop.id)).toMatchObject({ onHand: 20, reserved: 2 });
      const holds = await prisma.stockReservation.findMany({ where: { orderId: o.id } });
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ status: 'ACTIVE', quantity: 2, locationId: shop.id });

      // cart emptied, HSN stored on the line
      expect((await call('get', '/cart', token).expect(200)).body.itemCount).toBe(0);
      expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id } })).hsnCode).toBe('6109');
      expect(await prisma.order.count({ where: { userId: id } })).toBe(1);
    });

    it('prices from the database and ignores any totals or prices the client sends', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const v = await stocked({ price: 59900 });
      await fill(token, [[v, 1]]);
      const res = await call('post', '/checkout', token)
        .send({ ...ship(addressId), total: 1, subtotal: 1, shippingFee: 0, unitPrice: 1, items: [{ variantId: v.id, quantity: 1, unitPrice: 1 }] })
        .expect(201);
      expect(res.body).toMatchObject({ subtotal: 59900, shippingFee: 5000, total: 64900 });
    });

    it('freezes prices and addresses: later edits do not change an existing order', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const v = await stocked({ title: 'Frozen Tee', price: 59900 });
      await fill(token, [[v, 1]]);
      const placed = (await call('post', '/checkout', token).send(ship(addressId)).expect(201)).body;

      await prisma.productVariant.update({ where: { id: v.id }, data: { price: 99900, mrp: 120000 } });
      await prisma.product.update({ where: { id: v.productId }, data: { title: 'Renamed Tee', gstRate: 12 } });
      await call('patch', `/users/me/addresses/${addressId}`, token).send({ city: 'Mumbai', state: 'Maharashtra' }).expect(200);

      const again = (await call('get', `/orders/${placed.id}`, token).expect(200)).body;
      expect(again.total).toBe(64900);
      expect(again.items[0]).toMatchObject({ title: 'Frozen Tee (M)', unitPrice: 59900, gstRate: 5 });
      expect(again.shippingAddress).toMatchObject({ city: 'Dehradun', state: 'Uttarakhand' });
      expect(again.tax.intraState).toBe(true);
    });

    it('handles several lines with different GST slabs', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const a = await stocked({ price: 10500, gstRate: 5 });
      const b = await stocked({ price: 11800, gstRate: 18 });
      await fill(token, [[a, 1], [b, 1]]);
      const res = await call('post', '/checkout', token).send(ship(addressId)).expect(201);
      // goods 22300 (+5000 shipping): taxable 10000 + 10000 + 4237, tax 500 + 1800 + 763
      expect(res.body).toMatchObject({ subtotal: 22300, shippingFee: 5000, total: 27300 });
      expect(res.body.tax).toMatchObject({ taxableValue: 24237, totalTax: 3063 });
      expect(res.body.tax.cgst + res.body.tax.sgst).toBe(3063);
    });

    it('numbers orders in sequence', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const numbers: number[] = [];
      for (let i = 0; i < 2; i++) {
        await fill(token, [[await stocked(), 1]]);
        numbers.push((await call('post', '/checkout', token).send(ship(addressId)).expect(201)).body.number);
      }
      expect(numbers[1]).toBeGreaterThan(numbers[0]);
    });

    describe('store pickup', () => {
      it('holds stock at the chosen shop only and records the pickup details', async () => {
        const { token } = await shopper();
        const v = await stocked({}, 10);
        await setStock(prisma, v.id, shopB.id, 10);
        await fill(token, [[v, 3]]);

        const res = await call('post', '/checkout', token).send(pickup(shopB.id, { contactPhone: '9876500000' })).expect(201);

        expect(res.body).toMatchObject({ fulfilment: 'STORE_PICKUP', pickupLocationId: shopB.id, shippingFee: 0 });
        expect(res.body.shippingAddress).toMatchObject({
          type: 'PICKUP', contactPhone: '9876500000', locationId: shopB.id, locationName: 'Second Shop', pincode: '248001',
        });
        expect((await level(v.id, shopB.id)).reserved).toBe(3);
        expect((await level(v.id, shop.id)).reserved).toBe(0);
      });

      it('fails when the chosen shop has no stock, even if another location does', async () => {
        const { token } = await shopper();
        const v = await createVariant(prisma, { price: 59900, gstRate: 5 });
        await setStock(prisma, v.id, warehouse.id, 10); // only the warehouse has it
        await fill(token, [[v, 1]]);
        const res = await call('post', '/checkout', token).send(pickup(shop.id, { contactPhone: '9876500000' })).expect(409);
        expect(res.body.items[0]).toMatchObject({ requested: 1, available: 0 });
        expect(await prisma.order.count({ where: { items: { some: { variantId: v.id } } } })).toBe(0);
      });
    });

    describe('delivery stock allocation', () => {
      it('takes from the warehouse too when the shop alone is not enough', async () => {
        const { token } = await shopper();
        const addressId = await addAddress(token);
        const v = await stocked({}, 2);
        await setStock(prisma, v.id, warehouse.id, 5);
        await fill(token, [[v, 4]]);
        await call('post', '/checkout', token).send(ship(addressId)).expect(201);
        expect(await reservedTotal(v.id)).toBe(4);
      });
    });

    describe('when stock runs out', () => {
      it('rejects with the short items listed, creates no order and leaves the cart alone', async () => {
        const { token, id } = await shopper();
        const addressId = await addAddress(token);
        const v = await stocked({ title: 'Scarce Tee' }, 10);
        await fill(token, [[v, 3]]);
        await setStock(prisma, v.id, shop.id, 2);

        const res = await call('post', '/checkout', token).send(ship(addressId)).expect(409);

        expect(res.body.message).toMatch(/no longer available/);
        expect(res.body.items).toEqual([{ variantId: v.id, title: 'Scarce Tee (M)', sku: v.sku, requested: 3, available: 2 }]);
        expect(await prisma.order.count({ where: { userId: id } })).toBe(0);
        expect(await reservedTotal(v.id)).toBe(0);
        expect((await call('get', '/cart', token).expect(200)).body.itemCount).toBe(3);
      });

      it('is all or nothing across items: one short item holds nothing', async () => {
        const { token, id } = await shopper();
        const addressId = await addAddress(token);
        const fine = await stocked({}, 10);
        const scarce = await stocked({}, 10);
        await fill(token, [[fine, 2], [scarce, 2]]);
        await setStock(prisma, scarce.id, shop.id, 1);

        await call('post', '/checkout', token).send(ship(addressId)).expect(409);

        expect(await reservedTotal(fine.id)).toBe(0);
        expect(await prisma.order.count({ where: { userId: id } })).toBe(0);
        expect(await prisma.orderItem.count({ where: { variantId: fine.id } })).toBe(0);
      });
    });

    describe('races', () => {
      it('a double-click creates one order: the second request finds the cart already empty', async () => {
        const { token, id } = await shopper();
        const addressId = await addAddress(token);
        const v = await stocked({}, 20);
        await fill(token, [[v, 2]]);

        const results = await Promise.all([
          call('post', '/checkout', token).send(ship(addressId)),
          call('post', '/checkout', token).send(ship(addressId)),
          call('post', '/checkout', token).send(ship(addressId)),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
        expect(await prisma.order.count({ where: { userId: id } })).toBe(1);
        expect(await reservedTotal(v.id)).toBe(2); // held once, not three times
      });

      it('two customers racing for the last unit: exactly one gets it', async () => {
        const v = await stocked({}, 1);
        const buyers = await Promise.all([shopper(), shopper()]);
        const addresses = await Promise.all(buyers.map((b) => addAddress(b.token)));
        await Promise.all(buyers.map((b) => fill(b.token, [[v, 1]])));

        const results = await Promise.all(buyers.map((b, i) => call('post', '/checkout', b.token).send(ship(addresses[i]))));

        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(await level(v.id, shop.id)).toMatchObject({ onHand: 1, reserved: 1 });
        const loser = buyers[results.findIndex((r) => r.status === 409)];
        expect((await call('get', '/cart', loser.token).expect(200)).body.itemCount).toBe(1); // loser keeps their cart
      });

      it('ten customers for five units: five orders, five rejections, never oversold', async () => {
        const v = await stocked({}, 5);
        const buyers = await Promise.all(Array.from({ length: 10 }, shopper));
        const addresses = await Promise.all(buyers.map((b) => addAddress(b.token)));
        await Promise.all(buyers.map((b) => fill(b.token, [[v, 1]])));

        const results = await Promise.all(buyers.map((b, i) => call('post', '/checkout', b.token).send(ship(addresses[i]))));

        expect(results.filter((r) => r.status === 201)).toHaveLength(5);
        expect(results.filter((r) => r.status === 409)).toHaveLength(5);
        expect(await level(v.id, shop.id)).toMatchObject({ onHand: 5, reserved: 5 });
      });
    });

    it('limits how many unpaid orders one customer can have open', async () => {
      const { token } = await shopper();
      const addressId = await addAddress(token);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        await fill(token, [[await stocked(), 1]]);
        ids.push((await call('post', '/checkout', token).send(ship(addressId)).expect(201)).body.id);
      }
      await fill(token, [[await stocked(), 1]]);
      const blocked = await call('post', '/checkout', token).send(ship(addressId)).expect(409);
      expect(blocked.body.message).toMatch(/unpaid orders/);

      await call('post', `/orders/${ids[0]}/cancel`, token).expect(200);
      await call('post', '/checkout', token).send(ship(addressId)).expect(201); // room again
    });
  });

  describe('viewing orders', () => {
    it('lists only my orders, newest first, with pagination', async () => {
      const me = await shopper();
      const other = await shopper();
      const mine = await addAddress(me.token);
      const theirs = await addAddress(other.token);
      const placed: string[] = [];
      for (let i = 0; i < 3; i++) {
        await fill(me.token, [[await stocked(), 1]]);
        placed.push((await call('post', '/checkout', me.token).send(ship(mine)).expect(201)).body.id);
        await call('post', `/orders/${placed[i]}/cancel`, me.token).expect(200); // keep under the open-order limit
      }
      await fill(other.token, [[await stocked(), 1]]);
      await call('post', '/checkout', other.token).send(ship(theirs)).expect(201);

      const all = await call('get', '/orders', me.token).expect(200);
      expect(all.body.total).toBe(3);
      expect(all.body.items.map((o: any) => o.id)).toEqual([...placed].reverse());

      const page2 = await call('get', '/orders?limit=2&page=2', me.token).expect(200);
      expect(page2.body).toMatchObject({ total: 3, totalPages: 2 });
      expect(page2.body.items.map((o: any) => o.id)).toEqual([placed[0]]);
      await call('get', '/orders?limit=500', me.token).expect(400);
    });

    it('shows one order to its owner, and 404 to anyone else', async () => {
      const owner = await shopper();
      const addressId = await addAddress(owner.token);
      await fill(owner.token, [[await stocked(), 1]]);
      const order = (await call('post', '/checkout', owner.token).send(ship(addressId)).expect(201)).body;

      await call('get', `/orders/${order.id}`, owner.token).expect(200).expect((r) => expect(r.body.id).toBe(order.id));
      const stranger = await shopper();
      await call('get', `/orders/${order.id}`, stranger.token).expect(404);
      await call('get', '/orders/does-not-exist', owner.token).expect(404);
    });
  });

  describe('cancelling', () => {
    const place = async (qty = 2) => {
      const s = await shopper();
      const addressId = await addAddress(s.token);
      const v = await stocked({}, 10);
      await fill(s.token, [[v, qty]]);
      const order = (await call('post', '/checkout', s.token).send(ship(addressId)).expect(201)).body;
      return { ...s, v, order };
    };

    it('cancels an unpaid order and gives the stock back', async () => {
      const { token, v, order } = await place(3);
      expect((await level(v.id, shop.id)).reserved).toBe(3);

      const res = await call('post', `/orders/${order.id}/cancel`, token).expect(200);

      expect(res.body).toMatchObject({ id: order.id, status: 'CANCELLED', expiresAt: null });
      expect(await level(v.id, shop.id)).toMatchObject({ onHand: 10, reserved: 0 });
      expect((await prisma.stockReservation.findFirstOrThrow({ where: { orderId: order.id } })).status).toBe('RELEASED');
    });

    it('makes the stock available to the next customer straight away', async () => {
      const first = await place(2);
      const v = first.v;
      await setStock(prisma, v.id, shop.id, 2, 2); // 2 on hand, all of it held by the first order
      const next = await shopper();
      const addr = await addAddress(next.token);
      await call('post', '/cart/items', next.token).send({ variantId: v.id, quantity: 1 }).expect(409);

      await call('post', `/orders/${first.order.id}/cancel`, first.token).expect(200);

      await fill(next.token, [[v, 2]]);
      await call('post', '/checkout', next.token).send(ship(addr)).expect(201);
    });

    it('cannot be done twice, and the second attempt does not free stock again', async () => {
      const { token, v, order } = await place(2);
      await call('post', `/orders/${order.id}/cancel`, token).expect(200);
      const again = await call('post', `/orders/${order.id}/cancel`, token).expect(409);
      expect(again.body.message).toMatch(/already cancelled/);
      expect((await level(v.id, shop.id)).reserved).toBe(0);
    });

    it('refuses to cancel an order that has been paid, and keeps its stock held', async () => {
      const { token, v, order } = await place(2);
      await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
      const res = await call('post', `/orders/${order.id}/cancel`, token).expect(409);
      expect(res.body.message).toMatch(/can no longer be cancelled online/);
      expect((await level(v.id, shop.id)).reserved).toBe(2);
    });

    it('treats another customer’s order as not found', async () => {
      const { order, v } = await place(1);
      const stranger = await shopper();
      await call('post', `/orders/${order.id}/cancel`, stranger.token).expect(404);
      expect((await level(v.id, shop.id)).reserved).toBe(1);
      await call('post', '/orders/nope/cancel', stranger.token).expect(404);
    });

    it('two simultaneous cancels free the stock exactly once', async () => {
      const { token, v, order } = await place(2);
      const other = await place(1); // shares nothing; just proves untouched rows stay untouched
      const results = await Promise.all([
        call('post', `/orders/${order.id}/cancel`, token),
        call('post', `/orders/${order.id}/cancel`, token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await level(v.id, shop.id)).reserved).toBe(0);
      expect((await level(other.v.id, shop.id)).reserved).toBe(1);
    });
  });

  describe('unpaid orders expire', () => {
    const place = async () => {
      const s = await shopper();
      const addressId = await addAddress(s.token);
      const v = await stocked({}, 10);
      await fill(s.token, [[v, 2]]);
      const order = (await call('post', '/checkout', s.token).send(ship(addressId)).expect(201)).body;
      return { ...s, v, order };
    };
    const expire = (orderId: string) =>
      prisma.stockReservation.updateMany({ where: { orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    it('cancels the order and releases its stock once the hold has run out', async () => {
      const { token, v, order } = await place();
      await expire(order.id);

      const cancelled = await app.get(OrdersService).expireUnpaid();

      expect(cancelled).toContain(order.id);
      const res = await call('get', `/orders/${order.id}`, token).expect(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', expiresAt: null });
      expect(await level(v.id, shop.id)).toMatchObject({ onHand: 10, reserved: 0 });
    });

    it('leaves orders that are still within their hold time', async () => {
      const { token, v, order } = await place();
      await app.get(OrdersService).expireUnpaid();
      expect((await call('get', `/orders/${order.id}`, token).expect(200)).body.status).toBe('PENDING');
      expect((await level(v.id, shop.id)).reserved).toBe(2);
    });

    it('never cancels a paid order', async () => {
      const { token, order } = await place();
      await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
      await expire(order.id);
      await app.get(OrdersService).expireUnpaid();
      expect((await call('get', `/orders/${order.id}`, token).expect(200)).body.status).toBe('PAID');
    });

    it('lets the customer order again afterwards', async () => {
      const s = await shopper();
      const addressId = await addAddress(s.token);
      const v = await stocked({}, 2);
      await fill(s.token, [[v, 2]]);
      const order = (await call('post', '/checkout', s.token).send(ship(addressId)).expect(201)).body;
      await expire(order.id);
      await app.get(OrdersService).expireUnpaid();
      await fill(s.token, [[v, 2]]);
      await call('post', '/checkout', s.token).send(ship(addressId)).expect(201);
    });
  });
});
