import { ConflictException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { ReservationService } from '../src/inventory/reservation.service';
import { createLocation, createOrder, createTestApp, createVariant, resetDb, setStock } from './helpers';

describe('Stock reservations', () => {
  let app: NestExpressApplication;
  let svc: ReservationService;
  const prisma = new PrismaClient();

  let storeA: { id: string };
  let storeB: { id: string };

  const level = (variantId: string, locationId: string) =>
    prisma.stockLevel.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } });

  const totalReserved = async (variantId: string) =>
    (await prisma.stockLevel.findMany({ where: { variantId } })).reduce((n, l) => n + l.reserved, 0);

  /** Runs a reservation that should fail and returns the 409 body. */
  const rejection = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      return (e as ConflictException).getResponse() as { message: string; shortages: any[] };
    }
    throw new Error('Expected the reservation to be rejected');
  };

  beforeAll(async () => {
    await resetDb(prisma);
    app = await createTestApp();
    svc = app.get(ReservationService);
    storeA = await createLocation(prisma, 'Store A');
    storeB = await createLocation(prisma, 'Store B');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('reserve', () => {
    it('holds stock for the order and raises reserved', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);

      const holds = await svc.reserve(orderId, [{ variantId: v.id, quantity: 3 }]);

      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ orderId, variantId: v.id, locationId: storeA.id, quantity: 3, status: 'ACTIVE' });
      expect(await level(v.id, storeA.id)).toMatchObject({ onHand: 10, reserved: 3 });
    });

    it('holds for 30 minutes by default, or a custom time', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const [a] = await svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 1 }]);
      const [b] = await svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 1 }], { ttlMinutes: 5 });
      const minutes = (h: { expiresAt: Date }) => (h.expiresAt.getTime() - Date.now()) / 60_000;
      expect(minutes(a)).toBeGreaterThan(29);
      expect(minutes(a)).toBeLessThanOrEqual(30);
      expect(minutes(b)).toBeGreaterThan(4);
      expect(minutes(b)).toBeLessThanOrEqual(5);
    });

    it('adds up repeated lines for the same variant', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const holds = await svc.reserve(await createOrder(prisma), [
        { variantId: v.id, quantity: 2 }, { variantId: v.id, quantity: 3 },
      ]);
      expect(holds.map((h) => h.quantity)).toEqual([5]);
      expect((await level(v.id, storeA.id)).reserved).toBe(5);
    });

    it('reserves several different variants together', async () => {
      const a = await createVariant(prisma);
      const b = await createVariant(prisma);
      await setStock(prisma, a.id, storeA.id, 5);
      await setStock(prisma, b.id, storeA.id, 5);
      const holds = await svc.reserve(await createOrder(prisma), [
        { variantId: a.id, quantity: 2 }, { variantId: b.id, quantity: 4 },
      ]);
      expect(holds).toHaveLength(2);
      expect((await level(a.id, storeA.id)).reserved).toBe(2);
      expect((await level(b.id, storeA.id)).reserved).toBe(4);
    });

    it('can take exactly all the remaining stock', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 4);
      await svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 4 }]);
      expect(await level(v.id, storeA.id)).toMatchObject({ onHand: 4, reserved: 4 });
    });

    it('rejects when stock is short, reporting how many are available', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 3);
      const body = await rejection(svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 5 }]));
      expect(body.message).toBe('Insufficient stock');
      expect(body.shortages).toEqual([{ variantId: v.id, requested: 5, available: 3 }]);
      expect((await level(v.id, storeA.id)).reserved).toBe(0);
    });

    it('rejects a variant that has never been stocked', async () => {
      const v = await createVariant(prisma);
      const body = await rejection(svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 1 }]));
      expect(body.shortages).toEqual([{ variantId: v.id, requested: 1, available: 0 }]);
    });

    it('is all-or-nothing: one short item means nothing is held', async () => {
      const ok = await createVariant(prisma);
      const short = await createVariant(prisma);
      await setStock(prisma, ok.id, storeA.id, 10);
      await setStock(prisma, short.id, storeA.id, 1);
      const orderId = await createOrder(prisma);

      await rejection(svc.reserve(orderId, [{ variantId: ok.id, quantity: 4 }, { variantId: short.id, quantity: 2 }]));

      expect((await level(ok.id, storeA.id)).reserved).toBe(0); // the good item was rolled back
      expect(await prisma.stockReservation.count({ where: { orderId } })).toBe(0);
    });

    it('lists every short item, not just the first', async () => {
      const a = await createVariant(prisma);
      const b = await createVariant(prisma);
      await setStock(prisma, a.id, storeA.id, 1);
      await setStock(prisma, b.id, storeA.id, 2);
      const body = await rejection(svc.reserve(await createOrder(prisma), [
        { variantId: a.id, quantity: 5 }, { variantId: b.id, quantity: 9 },
      ]));
      expect(body.shortages.map((s) => [s.variantId, s.requested, s.available]).sort()).toEqual(
        [[a.id, 5, 1], [b.id, 9, 2]].sort(),
      );
    });

    it('does not count units already held by other orders', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 5);
      await svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 3 }]);
      const body = await rejection(svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 3 }]));
      expect(body.shortages[0]).toMatchObject({ requested: 3, available: 2 });
      await svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 2 }]); // the remaining 2 are fine
      expect((await level(v.id, storeA.id)).reserved).toBe(5);
    });

    it('splits across locations, taking from the one with most available first', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 3);
      await setStock(prisma, v.id, storeB.id, 4);
      const holds = await svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 6 }]);
      const by = Object.fromEntries(holds.map((h) => [h.locationId, h.quantity]));
      expect(by).toEqual({ [storeB.id]: 4, [storeA.id]: 2 });
      expect((await level(v.id, storeB.id)).reserved).toBe(4);
      expect((await level(v.id, storeA.id)).reserved).toBe(2);
    });

    it('can be limited to one location (store pickup)', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 3);
      await setStock(prisma, v.id, storeB.id, 4);
      const body = await rejection(svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 5 }], { locationId: storeA.id }));
      expect(body.shortages[0].available).toBe(3);
      const holds = await svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 3 }], { locationId: storeA.id });
      expect(holds.map((h) => h.locationId)).toEqual([storeA.id]);
      expect((await level(v.id, storeB.id)).reserved).toBe(0);
    });

    it('ignores stock in inactive locations', async () => {
      const v = await createVariant(prisma);
      const closed = await createLocation(prisma, 'Closed', { active: false });
      await setStock(prisma, v.id, closed.id, 10);
      await rejection(svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 1 }]));
      expect((await level(v.id, closed.id)).reserved).toBe(0);
    });

    it('joins the caller transaction, so a later failure undoes the holds', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 5);
      const orderId = await createOrder(prisma);
      await expect(
        prisma.$transaction(async (tx) => {
          await svc.reserve(orderId, [{ variantId: v.id, quantity: 2 }], { tx });
          throw new Error('payment setup failed'); // e.g. creating the Razorpay order fails
        }),
      ).rejects.toThrow('payment setup failed');
      expect((await level(v.id, storeA.id)).reserved).toBe(0);
      expect(await prisma.stockReservation.count({ where: { orderId } })).toBe(0);
    });
  });

  describe('release', () => {
    it('frees the held units and marks the holds RELEASED', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 4 }]);

      expect(await svc.release(orderId)).toBe(4);

      expect(await level(v.id, storeA.id)).toMatchObject({ onHand: 10, reserved: 0 });
      expect((await prisma.stockReservation.findMany({ where: { orderId } })).map((h) => h.status)).toEqual(['RELEASED']);
    });

    it('frees every location an order was split across', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 3);
      await setStock(prisma, v.id, storeB.id, 4);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 6 }]);
      expect(await svc.release(orderId)).toBe(6);
      expect(await totalReserved(v.id)).toBe(0);
    });

    it('is safe to call twice (never frees stock twice)', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      const other = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 4 }]);
      await svc.reserve(other, [{ variantId: v.id, quantity: 3 }]);

      expect(await svc.release(orderId)).toBe(4);
      expect(await svc.release(orderId)).toBe(0);
      expect((await level(v.id, storeA.id)).reserved).toBe(3); // the other order's hold is untouched
    });

    it('does nothing for an order with no holds', async () => {
      expect(await svc.release(await createOrder(prisma))).toBe(0);
      expect(await svc.release('does-not-exist')).toBe(0);
    });

    it('makes the units available to the next customer', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 2);
      const first = await createOrder(prisma);
      await svc.reserve(first, [{ variantId: v.id, quantity: 2 }]);
      await rejection(svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 1 }]));
      await svc.release(first);
      await svc.reserve(await createOrder(prisma), [{ variantId: v.id, quantity: 2 }]);
    });
  });

  describe('commit (sale)', () => {
    it('reduces on-hand and reserved, and logs a SALE movement against the order', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 3 }]);

      expect(await svc.commit(orderId)).toBe(3);

      expect(await level(v.id, storeA.id)).toMatchObject({ onHand: 7, reserved: 0 });
      const sale = await prisma.stockMovement.findFirstOrThrow({ where: { variantId: v.id, orderId } });
      expect(sale).toMatchObject({ type: 'SALE', quantity: -3, balanceAfter: 7, locationId: storeA.id });
      expect((await prisma.stockReservation.findFirstOrThrow({ where: { orderId } })).status).toBe('COMMITTED');
    });

    it('records one movement per location when an order was split', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 3);
      await setStock(prisma, v.id, storeB.id, 4);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 6 }]);
      await svc.commit(orderId);
      const moves = await prisma.stockMovement.findMany({ where: { orderId }, orderBy: { quantity: 'asc' } });
      expect(moves.map((m) => [m.locationId, m.quantity]).sort()).toEqual([[storeA.id, -2], [storeB.id, -4]].sort());
    });

    it('is safe to call twice (never sells the same units twice)', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 3 }]);
      expect(await svc.commit(orderId)).toBe(3);
      expect(await svc.commit(orderId)).toBe(0); // e.g. a duplicate payment webhook
      expect((await level(v.id, storeA.id)).onHand).toBe(7);
      expect(await prisma.stockMovement.count({ where: { orderId } })).toBe(1);
    });

    it('does nothing if the hold was already released (caller must reserve again)', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 3 }]);
      await svc.release(orderId);
      expect(await svc.commit(orderId)).toBe(0);
      expect(await level(v.id, storeA.id)).toMatchObject({ onHand: 10, reserved: 0 });
    });

    it('cannot be undone by a late release', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 3 }]);
      await svc.commit(orderId);
      expect(await svc.release(orderId)).toBe(0); // sold stock is not given back
      expect((await level(v.id, storeA.id)).onHand).toBe(7);
    });

    it('still commits a hold that has passed its expiry but was not yet released', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 2 }], { ttlMinutes: -10 }); // already expired
      expect(await svc.commit(orderId)).toBe(2); // payment arrived late but the stock was still ours
    });

    it('only touches its own order', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const a = await createOrder(prisma);
      const b = await createOrder(prisma);
      await svc.reserve(a, [{ variantId: v.id, quantity: 2 }]);
      await svc.reserve(b, [{ variantId: v.id, quantity: 3 }]);
      await svc.commit(a);
      expect(await level(v.id, storeA.id)).toMatchObject({ onHand: 8, reserved: 3 });
    });
  });

  describe('releaseExpired', () => {
    it('frees holds past their expiry and returns the order ids', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const stale = await createOrder(prisma);
      const fresh = await createOrder(prisma);
      await svc.reserve(stale, [{ variantId: v.id, quantity: 4 }], { ttlMinutes: -1 });
      await svc.reserve(fresh, [{ variantId: v.id, quantity: 2 }], { ttlMinutes: 30 });

      const released = await svc.releaseExpired();

      expect(released).toContain(stale);
      expect(released).not.toContain(fresh);
      expect((await level(v.id, storeA.id)).reserved).toBe(2);
      expect((await prisma.stockReservation.findFirstOrThrow({ where: { orderId: fresh } })).status).toBe('ACTIVE');
    });

    it('leaves committed sales alone', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 2 }], { ttlMinutes: -1 });
      await svc.commit(orderId);
      expect(await svc.releaseExpired()).not.toContain(orderId);
      expect((await level(v.id, storeA.id)).onHand).toBe(8);
    });

    it('accepts a custom clock', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const orderId = await createOrder(prisma);
      await svc.reserve(orderId, [{ variantId: v.id, quantity: 2 }], { ttlMinutes: 30 });
      expect(await svc.releaseExpired()).not.toContain(orderId);
      expect(await svc.releaseExpired(new Date(Date.now() + 31 * 60_000))).toContain(orderId);
    });

    it('returns an empty list when nothing has expired', async () => {
      expect(await svc.releaseExpired(new Date(0))).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('never oversells: 20 simultaneous buyers for 5 units, exactly 5 succeed', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 5);
      const orders = await Promise.all(Array.from({ length: 20 }, () => createOrder(prisma)));

      const results = await Promise.allSettled(orders.map((id) => svc.reserve(id, [{ variantId: v.id, quantity: 1 }])));

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(failures).toHaveLength(15);
      expect(failures.every((f) => f.reason instanceof ConflictException)).toBe(true);
      expect(await level(v.id, storeA.id)).toMatchObject({ onHand: 5, reserved: 5 });
      expect(await prisma.stockReservation.count({ where: { variantId: v.id, status: 'ACTIVE' } })).toBe(5);
    });

    it('never oversells with bigger baskets: 6 buyers wanting 2 each of 7 units gives 3 winners', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 7);
      const orders = await Promise.all(Array.from({ length: 6 }, () => createOrder(prisma)));
      const results = await Promise.allSettled(orders.map((id) => svc.reserve(id, [{ variantId: v.id, quantity: 2 }])));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
      expect((await level(v.id, storeA.id)).reserved).toBe(6);
    });

    it('never oversells across two locations', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 3);
      await setStock(prisma, v.id, storeB.id, 3);
      const orders = await Promise.all(Array.from({ length: 12 }, () => createOrder(prisma)));
      const results = await Promise.allSettled(orders.map((id) => svc.reserve(id, [{ variantId: v.id, quantity: 1 }])));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
      expect(await totalReserved(v.id)).toBe(6);
      const rows = await prisma.stockLevel.findMany({ where: { variantId: v.id } });
      expect(rows.every((r) => r.reserved <= r.onHand)).toBe(true);
    });

    it('survives two multi-item orders reserving the same variants in opposite order (no deadlock)', async () => {
      const a = await createVariant(prisma);
      const b = await createVariant(prisma);
      await setStock(prisma, a.id, storeA.id, 100);
      await setStock(prisma, b.id, storeA.id, 100);
      const orders = await Promise.all(Array.from({ length: 10 }, () => createOrder(prisma)));
      const results = await Promise.allSettled(
        orders.map((id, i) =>
          svc.reserve(id, i % 2 ? [{ variantId: a.id, quantity: 1 }, { variantId: b.id, quantity: 1 }]
                              : [{ variantId: b.id, quantity: 1 }, { variantId: a.id, quantity: 1 }]),
        ),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect((await level(a.id, storeA.id)).reserved).toBe(10);
      expect((await level(b.id, storeA.id)).reserved).toBe(10);
    });

    it('lets exactly one of release and commit win when they race for the same order', async () => {
      for (let round = 0; round < 5; round++) {
        const v = await createVariant(prisma);
        await setStock(prisma, v.id, storeA.id, 10);
        const orderId = await createOrder(prisma);
        await svc.reserve(orderId, [{ variantId: v.id, quantity: 2 }]);

        const [released, committed] = await Promise.all([svc.release(orderId), svc.commit(orderId)]);

        expect(released + committed).toBe(2); // 2 units were held; only one operation got them
        const l = await level(v.id, storeA.id);
        expect(l.reserved).toBe(0);
        expect(l.onHand).toBe(committed === 2 ? 8 : 10);
      }
    });

    it('does not double-release when release is called in parallel', async () => {
      const v = await createVariant(prisma);
      await setStock(prisma, v.id, storeA.id, 10);
      const mine = await createOrder(prisma);
      const other = await createOrder(prisma);
      await svc.reserve(mine, [{ variantId: v.id, quantity: 4 }]);
      await svc.reserve(other, [{ variantId: v.id, quantity: 3 }]);

      const freed = await Promise.all([svc.release(mine), svc.release(mine), svc.release(mine)]);

      expect(freed.reduce((n, x) => n + x, 0)).toBe(4);
      expect((await level(v.id, storeA.id)).reserved).toBe(3);
    });
  });
});
