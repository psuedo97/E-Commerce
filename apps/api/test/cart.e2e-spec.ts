import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { CartService } from '../src/cart/cart.service';
import { createLocation, createTestApp, createVariant, registerCustomer, resetDb, setStock } from './helpers';

describe('Cart', () => {
  let app: NestExpressApplication;
  let shop: { id: string };
  const prisma = new PrismaClient();

  const api = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(app.getHttpServer())[method](`/api/v1${path}`);
  /** Guest requests identify their cart with the X-Cart-Id header; logged-in users send a Bearer token. */
  const guest = (method: 'get' | 'post' | 'patch' | 'delete', path: string, cartId?: string) => {
    const r = api(method, path);
    return cartId ? r.set('X-Cart-Id', cartId) : r;
  };
  const user = (method: 'get' | 'post' | 'patch' | 'delete', path: string, token: string) =>
    api(method, path).set('Authorization', `Bearer ${token}`);

  /** A buyable variant with plenty of stock unless told otherwise. */
  const stocked = async (over: Parameters<typeof createVariant>[1] = {}, onHand = 50, reserved = 0) => {
    const v = await createVariant(prisma, over);
    await setStock(prisma, v.id, shop.id, onHand, reserved);
    return v;
  };

  beforeAll(async () => {
    await resetDb(prisma);
    app = await createTestApp();
    shop = await createLocation(prisma, 'Shop');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('as a guest', () => {
    it('is empty before anything is added, and nothing is created by looking', async () => {
      const before = await prisma.cart.count();
      const res = await guest('get', '/cart').expect(200);
      expect(res.body).toEqual({ id: null, items: [], itemCount: 0, subtotal: 0, hasIssues: false });
      expect(await prisma.cart.count()).toBe(before);
    });

    it('creates a cart on the first add and returns its id and priced lines', async () => {
      const v = await stocked({ title: 'Guest Tee', price: 59900, gstRate: 5 });
      const res = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 2 }).expect(201);
      expect(res.body.id).toEqual(expect.any(String));
      expect(res.body).toMatchObject({ itemCount: 2, subtotal: 119800, hasIssues: false });
      expect(res.body.items[0]).toMatchObject({
        variantId: v.id, sku: v.sku, title: 'Guest Tee', unitPrice: 59900, quantity: 2, lineTotal: 119800,
        gstRate: 5, status: 'OK', attributes: { size: 'M' }, image: null,
      });
    });

    it('keeps adding to the same cart when the id is sent back', async () => {
      const a = await stocked();
      const b = await stocked();
      const first = await guest('post', '/cart/items').send({ variantId: a.id, quantity: 1 }).expect(201);
      const id = first.body.id;
      await guest('post', '/cart/items', id).send({ variantId: b.id, quantity: 1 }).expect(201);
      const res = await guest('post', '/cart/items', id).send({ variantId: a.id, quantity: 2 }).expect(201);
      expect(res.body.id).toBe(id);
      expect(res.body.items.map((i: any) => [i.variantId, i.quantity]).sort()).toEqual([[a.id, 3], [b.id, 1]].sort());
      const read = await guest('get', '/cart', id).expect(200);
      expect(read.body.itemCount).toBe(4);
    });

    it('gives a fresh cart to an unknown or expired cart id', async () => {
      const v = await stocked();
      const res = await guest('post', '/cart/items', 'not-a-real-cart').send({ variantId: v.id, quantity: 1 }).expect(201);
      expect(res.body.id).not.toBe('not-a-real-cart');
      expect(res.body.itemCount).toBe(1);
    });

    it('cannot read a logged-in customer’s cart by using its id', async () => {
      const v = await stocked();
      const token = await registerCustomer(app);
      await user('post', '/cart/items', token).send({ variantId: v.id, quantity: 1 }).expect(201);
      const cart = await prisma.cart.findFirstOrThrow({ where: { userId: { not: null } }, orderBy: { createdAt: 'desc' } });

      const res = await guest('get', '/cart', cart.id).expect(200);
      expect(res.body.items).toEqual([]);
    });
  });

  describe('as a logged-in customer', () => {
    it('saves the cart to the account and returns it on the next request', async () => {
      const v = await stocked();
      const token = await registerCustomer(app);
      await user('post', '/cart/items', token).send({ variantId: v.id, quantity: 3 }).expect(201);
      const res = await user('get', '/cart', token).expect(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ variantId: v.id, quantity: 3 });
    });

    it('ignores a guest cart id header (the account cart wins)', async () => {
      const a = await stocked();
      const b = await stocked();
      const g = await guest('post', '/cart/items').send({ variantId: b.id, quantity: 1 }).expect(201);
      const token = await registerCustomer(app);
      await user('post', '/cart/items', token).send({ variantId: a.id, quantity: 1 }).expect(201);
      const res = await user('get', '/cart', token).set('X-Cart-Id', g.body.id).expect(200);
      expect(res.body.items.map((i: any) => i.variantId)).toEqual([a.id]);
    });

    it('rejects a bad token instead of silently treating the caller as a guest', async () => {
      await api('get', '/cart').set('Authorization', 'Bearer not.a.token').expect(401);
      await api('get', '/cart').set('Authorization', 'Basic abc').expect(401);
    });
  });

  describe('adding items', () => {
    it.each([
      ['zero quantity', { quantity: 0 }],
      ['negative quantity', { quantity: -1 }],
      ['more than the per-line limit', { quantity: 11 }],
      ['fractional quantity', { quantity: 1.5 }],
      ['text quantity', { quantity: 'two' }],
      ['missing variant', { variantId: undefined }],
    ])('rejects %s', async (_label, over: Record<string, unknown>) => {
      const v = await stocked();
      await guest('post', '/cart/items').send({ variantId: v.id, quantity: 1, ...over }).expect(400);
    });

    it('404s for an unknown variant', async () => {
      await guest('post', '/cart/items').send({ variantId: 'nope', quantity: 1 }).expect(404);
    });

    it('will not add a draft or archived product', async () => {
      for (const status of ['DRAFT', 'ARCHIVED'] as const) {
        const v = await stocked();
        await prisma.product.update({ where: { id: v.productId }, data: { status } });
        await guest('post', '/cart/items').send({ variantId: v.id, quantity: 1 }).expect(404);
      }
    });

    it('stops at the per-line limit of 10, across several adds', async () => {
      const v = await stocked({}, 100);
      const first = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 6 }).expect(201);
      const res = await guest('post', '/cart/items', first.body.id).send({ variantId: v.id, quantity: 5 }).expect(400);
      expect(res.body.message).toMatch(/at most 10/);
    });

    describe('stock limits', () => {
      it('refuses more than is available and says how many are', async () => {
        const v = await stocked({}, 3);
        const res = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 4 }).expect(409);
        expect(res.body).toMatchObject({ message: 'Only 3 available', available: 3 });
      });

      it('counts what is already in the cart', async () => {
        const v = await stocked({}, 5);
        const first = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 3 }).expect(201);
        await guest('post', '/cart/items', first.body.id).send({ variantId: v.id, quantity: 3 }).expect(409);
        await guest('post', '/cart/items', first.body.id).send({ variantId: v.id, quantity: 2 }).expect(201);
      });

      it('says "Out of stock" when nothing is left', async () => {
        const v = await stocked({}, 0);
        const res = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 1 }).expect(409);
        expect(res.body.message).toBe('Out of stock');
      });

      it('does not count units reserved for other orders', async () => {
        const v = await stocked({}, 5, 4); // 1 free
        await guest('post', '/cart/items').send({ variantId: v.id, quantity: 2 }).expect(409);
        await guest('post', '/cart/items').send({ variantId: v.id, quantity: 1 }).expect(201);
      });

      it('does not count stock in inactive locations', async () => {
        const v = await createVariant(prisma);
        const closed = await createLocation(prisma, 'Closed', { active: false });
        await setStock(prisma, v.id, closed.id, 20);
        await guest('post', '/cart/items').send({ variantId: v.id, quantity: 1 }).expect(409);
      });
    });
  });

  describe('changing the cart', () => {
    it('sets a quantity (replaces, does not add)', async () => {
      const v = await stocked();
      const g = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 2 }).expect(201);
      const res = await guest('patch', `/cart/items/${v.id}`, g.body.id).send({ quantity: 5 }).expect(200);
      expect(res.body.items[0].quantity).toBe(5);
      const down = await guest('patch', `/cart/items/${v.id}`, g.body.id).send({ quantity: 1 }).expect(200);
      expect(down.body.items[0].quantity).toBe(1);
    });

    it('validates a new quantity against stock and limits', async () => {
      const v = await stocked({}, 4);
      const g = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 1 }).expect(201);
      await guest('patch', `/cart/items/${v.id}`, g.body.id).send({ quantity: 5 }).expect(409);
      await guest('patch', `/cart/items/${v.id}`, g.body.id).send({ quantity: 0 }).expect(400);
      await guest('patch', `/cart/items/${v.id}`, g.body.id).send({ quantity: 11 }).expect(400);
    });

    it('404s when changing or removing something that is not in the cart', async () => {
      const inCart = await stocked();
      const other = await stocked();
      const g = await guest('post', '/cart/items').send({ variantId: inCart.id, quantity: 1 }).expect(201);
      await guest('patch', `/cart/items/${other.id}`, g.body.id).send({ quantity: 1 }).expect(404);
      await guest('delete', `/cart/items/${other.id}`, g.body.id).expect(404);
      await guest('delete', `/cart/items/${inCart.id}`).expect(404); // no cart at all
    });

    it('removes one item and keeps the rest', async () => {
      const a = await stocked();
      const b = await stocked();
      const g = await guest('post', '/cart/items').send({ variantId: a.id, quantity: 1 }).expect(201);
      await guest('post', '/cart/items', g.body.id).send({ variantId: b.id, quantity: 1 }).expect(201);
      const res = await guest('delete', `/cart/items/${a.id}`, g.body.id).expect(200);
      expect(res.body.items.map((i: any) => i.variantId)).toEqual([b.id]);
    });

    it('clears the cart but keeps its id', async () => {
      const v = await stocked();
      const g = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 2 }).expect(201);
      const res = await guest('delete', '/cart', g.body.id).expect(200);
      expect(res.body).toMatchObject({ id: g.body.id, items: [], itemCount: 0, subtotal: 0 });
      await guest('delete', '/cart').expect(200); // clearing nothing is fine
    });
  });

  describe('what the cart shows', () => {
    it('uses the current database price, so price changes show up immediately', async () => {
      const v = await stocked({ price: 40000 });
      const g = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 2 }).expect(201);
      expect(g.body.subtotal).toBe(80000);
      await prisma.productVariant.update({ where: { id: v.id }, data: { price: 45000, mrp: 50000 } });
      const res = await guest('get', '/cart', g.body.id).expect(200);
      expect(res.body.items[0]).toMatchObject({ unitPrice: 45000, mrp: 50000, lineTotal: 90000 });
      expect(res.body.subtotal).toBe(90000);
    });

    it('flags lines that need attention after stock or availability changes', async () => {
      const ok = await stocked({}, 50);
      const low = await stocked({}, 50);
      const out = await stocked({}, 50);
      const gone = await stocked({}, 50);
      let g = await guest('post', '/cart/items').send({ variantId: ok.id, quantity: 1 }).expect(201);
      for (const [v, q] of [[low, 5], [out, 2], [gone, 1]] as const) {
        g = await guest('post', '/cart/items', g.body.id).send({ variantId: v.id, quantity: q }).expect(201);
      }
      await setStock(prisma, low.id, shop.id, 3); // 5 in cart, 3 left
      await setStock(prisma, out.id, shop.id, 0);
      await prisma.product.update({ where: { id: gone.productId }, data: { status: 'ARCHIVED' } });

      const res = await guest('get', '/cart', g.body.id).expect(200);
      const status = Object.fromEntries(res.body.items.map((i: any) => [i.variantId, i.status]));
      expect(status).toEqual({
        [ok.id]: 'OK', [low.id]: 'LOW_STOCK', [out.id]: 'OUT_OF_STOCK', [gone.id]: 'UNAVAILABLE',
      });
      expect(res.body.hasIssues).toBe(true);
      expect(res.body.items.find((i: any) => i.variantId === low.id).available).toBe(3);
    });

    it('caps the shown availability at the per-line limit', async () => {
      const v = await stocked({}, 500);
      const g = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 1 }).expect(201);
      expect(g.body.items[0].available).toBe(10);
    });

    it('drops a line automatically if its variant is deleted', async () => {
      const keep = await stocked();
      const doomed = await stocked();
      let g = await guest('post', '/cart/items').send({ variantId: keep.id, quantity: 1 }).expect(201);
      g = await guest('post', '/cart/items', g.body.id).send({ variantId: doomed.id, quantity: 1 }).expect(201);
      await prisma.productVariant.delete({ where: { id: doomed.id } });
      const res = await guest('get', '/cart', g.body.id).expect(200);
      expect(res.body.items.map((i: any) => i.variantId)).toEqual([keep.id]);
    });
  });

  describe('merging a guest cart after login', () => {
    it('adds guest items to the account cart, summing duplicates, then removes the guest cart', async () => {
      const a = await stocked();
      const b = await stocked();
      const token = await registerCustomer(app);
      await user('post', '/cart/items', token).send({ variantId: a.id, quantity: 3 }).expect(201);
      let g = await guest('post', '/cart/items').send({ variantId: a.id, quantity: 2 }).expect(201);
      g = await guest('post', '/cart/items', g.body.id).send({ variantId: b.id, quantity: 1 }).expect(201);

      const res = await user('post', '/cart/merge', token).send({ guestCartId: g.body.id }).expect(201);

      expect(res.body.items.map((i: any) => [i.variantId, i.quantity]).sort()).toEqual([[a.id, 5], [b.id, 1]].sort());
      expect(await prisma.cart.count({ where: { id: g.body.id } })).toBe(0);
    });

    it('works when the account has no cart yet', async () => {
      const v = await stocked();
      const token = await registerCustomer(app);
      const g = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 2 }).expect(201);
      const res = await user('post', '/cart/merge', token).send({ guestCartId: g.body.id }).expect(201);
      expect(res.body.items[0]).toMatchObject({ variantId: v.id, quantity: 2 });
    });

    it('is safe to repeat: a second merge changes nothing', async () => {
      const v = await stocked();
      const token = await registerCustomer(app);
      const g = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 2 }).expect(201);
      await user('post', '/cart/merge', token).send({ guestCartId: g.body.id }).expect(201);
      const again = await user('post', '/cart/merge', token).send({ guestCartId: g.body.id }).expect(201);
      expect(again.body.items[0].quantity).toBe(2);
    });

    it('caps a merged line at 10', async () => {
      const v = await stocked({}, 100);
      const token = await registerCustomer(app);
      await user('post', '/cart/items', token).send({ variantId: v.id, quantity: 8 }).expect(201);
      const g = await guest('post', '/cart/items').send({ variantId: v.id, quantity: 7 }).expect(201);
      const res = await user('post', '/cart/merge', token).send({ guestCartId: g.body.id }).expect(201);
      expect(res.body.items[0].quantity).toBe(10);
    });

    it('requires login, and will not absorb another customer’s cart', async () => {
      const v = await stocked();
      await guest('post', '/cart/merge').send({ guestCartId: 'x' }).expect(401);

      const victim = await registerCustomer(app);
      await user('post', '/cart/items', victim).send({ variantId: v.id, quantity: 1 }).expect(201);
      const victimCart = await prisma.cart.findFirstOrThrow({ where: { userId: { not: null } }, orderBy: { createdAt: 'desc' } });

      const thief = await registerCustomer(app);
      const res = await user('post', '/cart/merge', thief).send({ guestCartId: victimCart.id }).expect(201);
      expect(res.body.items).toEqual([]);
      expect(await prisma.cartItem.count({ where: { cartId: victimCart.id } })).toBe(1); // untouched
    });

    it('ignores an unknown guest cart id', async () => {
      const token = await registerCustomer(app);
      const res = await user('post', '/cart/merge', token).send({ guestCartId: 'gone' }).expect(201);
      expect(res.body.items).toEqual([]);
    });
  });

  describe('housekeeping', () => {
    it('purges only guest carts that have been idle for 30+ days', async () => {
      const old = await prisma.cart.create({ data: {} });
      const recent = await prisma.cart.create({ data: {} });
      const accountUser = await prisma.user.create({ data: { name: 'Old Acct', email: 'old-acct@example.com', passwordHash: 'x' } });
      const oldAccountCart = await prisma.cart.create({ data: { userId: accountUser.id } });
      // updatedAt is managed by Prisma, so backdate with SQL.
      await prisma.$executeRaw`UPDATE "Cart" SET "updatedAt" = NOW() - INTERVAL '45 days' WHERE id IN (${old.id}, ${oldAccountCart.id})`;
      await prisma.$executeRaw`UPDATE "Cart" SET "updatedAt" = NOW() - INTERVAL '5 days' WHERE id = ${recent.id}`;

      const removed = await app.get(CartService).purgeStaleGuestCarts();

      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await prisma.cart.findUnique({ where: { id: old.id } })).toBeNull();
      expect(await prisma.cart.findUnique({ where: { id: recent.id } })).not.toBeNull();
      expect(await prisma.cart.findUnique({ where: { id: oldAccountCart.id } })).not.toBeNull(); // account carts stay
    });
  });
});
