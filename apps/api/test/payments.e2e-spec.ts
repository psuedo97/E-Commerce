import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PaymentsService } from '../src/payments/payments.service';
import { RefundsService } from '../src/payments/refunds.service';
import { OrdersService } from '../src/orders/orders.service';
import { FakeGateway, FakeMailer } from './fakes';
import { adminToken, createTestApp, placePendingOrder, registerCustomer, resetDb, staffToken } from './helpers';

describe('Payments', () => {
  let app: NestExpressApplication;
  let admin: string;
  const gateway = new FakeGateway();
  const mailer = new FakeMailer();
  const prisma = new PrismaClient();

  const http = () => request(app.getHttpServer());
  const authed = (method: 'get' | 'post', path: string, token: string) =>
    http()[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  const pay = (token: string, orderId: string) => authed('post', `/orders/${orderId}/pay`, token);
  const verify = (token: string, body: object) => authed('post', '/payments/verify', token).send(body);
  const refund = (orderId: string, body: object, token = admin) => authed('post', `/admin/orders/${orderId}/refund`, token).send(body);

  /** Posts a provider webhook exactly as Razorpay would: signed over the raw body. */
  const webhook = (payload: object, opts: { eventId?: string; signature?: string | null; body?: string } = {}) => {
    const body = opts.body ?? JSON.stringify(payload);
    const r = http().post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json');
    if (opts.signature !== null) r.set('X-Razorpay-Signature', opts.signature ?? gateway.signWebhook(body));
    if (opts.eventId) r.set('X-Razorpay-Event-Id', opts.eventId);
    return r.send(body);
  };
  let eventSeq = 0;
  const nextEvent = () => `evt_${Date.now()}_${++eventSeq}`;

  const captured = (providerOrderId: string, paymentId: string, amount: number) => ({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: providerOrderId, amount, status: 'captured' } } },
  });
  const failed = (providerOrderId: string, paymentId: string, description = 'Payment declined by bank') => ({
    event: 'payment.failed',
    payload: { payment: { entity: { id: paymentId, order_id: providerOrderId, error_description: description } } },
  });
  const refundProcessed = (refundId: string, paymentId: string, amount: number) => ({
    event: 'refund.processed',
    payload: { refund: { entity: { id: refundId, payment_id: paymentId, amount } } },
  });

  const level = (variantId: string, locationId: string) =>
    prisma.stockLevel.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } });
  const orderRow = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const paymentRow = (orderId: string) => prisma.payment.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' } });

  type Placed = Awaited<ReturnType<typeof placePendingOrder>>;

  /** An order that has been placed, and for which the payment window has been opened. */
  const started = async (opts: Parameters<typeof placePendingOrder>[2] = {}) => {
    const placed = await placePendingOrder(app, prisma, opts);
    const init = (await pay(placed.token, placed.order.id).expect(200)).body;
    return { ...placed, init };
  };
  /** An order that has been placed and paid through the browser route. */
  const paid = async (opts: Parameters<typeof placePendingOrder>[2] = {}) => {
    const s = await started(opts);
    const paymentId = `pay_${Math.random().toString(36).slice(2, 10)}`;
    await verify(s.token, {
      razorpay_order_id: s.init.providerOrderId, razorpay_payment_id: paymentId,
      razorpay_signature: gateway.signCheckout(s.init.providerOrderId, paymentId),
    }).expect(200);
    return { ...s, paymentId };
  };
  const expireHold = async (orderId: string) => {
    const past = new Date(Date.now() - 60_000);
    await prisma.stockReservation.updateMany({ where: { orderId }, data: { expiresAt: past } });
    await prisma.order.update({ where: { id: orderId }, data: { expiresAt: past } });
    await app.get(OrdersService).expireUnpaid();
  };

  beforeAll(async () => {
    await resetDb(prisma);
    app = await createTestApp({ gateway, mailer });
    admin = await adminToken(app, prisma);
  });

  beforeEach(() => {
    gateway.createdOrders = [];
    gateway.refunds = [];
    gateway.failCreateOrder = false;
    gateway.failRefundsRemaining = 0;
    gateway.refundStatus = 'processed';
    mailer.sent = [];
    mailer.fail = false;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------------------------
  describe('starting a payment (POST /orders/:id/pay)', () => {
    it('needs a login', async () => {
      await http().post('/api/v1/orders/x/pay').expect(401);
    });

    it('creates a provider order for exactly the order total and returns what the payment window needs', async () => {
      const p = await placePendingOrder(app, prisma);
      const res = await pay(p.token, p.order.id).expect(200);

      expect(res.body).toMatchObject({
        provider: 'razorpay', keyId: 'rzp_test_fake', amount: 64900, currency: 'INR',
        orderId: p.order.id, orderNumber: p.order.number,
      });
      expect(res.body.prefill).toMatchObject({ name: 'Test Customer', email: p.email });
      expect(gateway.createdOrders).toHaveLength(1);
      expect(gateway.createdOrders[0]).toMatchObject({ amount: 64900, receipt: `KOMA-${p.order.number}`, id: res.body.providerOrderId });
      expect(await paymentRow(p.order.id)).toMatchObject({
        status: 'CREATED', amount: 64900, provider: 'razorpay', providerOrderId: res.body.providerOrderId, providerPaymentId: null,
      });
    });

    it('never asks the client for an amount (it is always the server-side order total)', async () => {
      const p = await placePendingOrder(app, prisma, { quantity: 2 });
      await pay(p.token, p.order.id).send({ amount: 1 }).expect(200);
      expect(gateway.createdOrders[0].amount).toBe(119800);
    });

    it('returns the same provider order when called again (no duplicate payments)', async () => {
      const p = await placePendingOrder(app, prisma);
      const first = (await pay(p.token, p.order.id).expect(200)).body;
      const second = (await pay(p.token, p.order.id).expect(200)).body;
      expect(second.providerOrderId).toBe(first.providerOrderId);
      expect(gateway.createdOrders).toHaveLength(1);
      expect(await prisma.payment.count({ where: { orderId: p.order.id } })).toBe(1);
    });

    it('creates only one payment when "Pay" is clicked several times at once', async () => {
      const p = await placePendingOrder(app, prisma);
      const results = await Promise.all([1, 2, 3, 4].map(() => pay(p.token, p.order.id)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.providerOrderId)).size).toBe(1);
      expect(await prisma.payment.count({ where: { orderId: p.order.id } })).toBe(1);
    });

    it('treats another customer’s order as not found', async () => {
      const p = await placePendingOrder(app, prisma);
      const stranger = await registerCustomer(app);
      await pay(stranger, p.order.id).expect(404);
      await pay(p.token, 'does-not-exist').expect(404);
      expect(gateway.createdOrders).toHaveLength(0);
    });

    it.each([
      ['cancelled', { status: 'CANCELLED' as const }, /cancelled/],
      ['already paid', { status: 'PAID' as const }, /already been paid/],
    ])('refuses an order that is %s (409)', async (_label, change, message) => {
      const p = await placePendingOrder(app, prisma);
      await prisma.order.update({ where: { id: p.order.id }, data: change });
      const res = await pay(p.token, p.order.id).expect(409);
      expect(res.body.message).toMatch(message);
      expect(gateway.createdOrders).toHaveLength(0);
    });

    it('refuses an order whose hold has expired', async () => {
      const p = await placePendingOrder(app, prisma);
      await prisma.order.update({ where: { id: p.order.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await pay(p.token, p.order.id).expect(409);
      expect(res.body.message).toMatch(/expired/);
    });

    it('refuses orders that are not paid online', async () => {
      const p = await placePendingOrder(app, prisma);
      await prisma.order.update({ where: { id: p.order.id }, data: { paymentMethod: 'COD' } });
      await pay(p.token, p.order.id).expect(400);
    });

    it('stretches the stock hold to about 20 minutes so it cannot expire mid-payment', async () => {
      const p = await placePendingOrder(app, prisma);
      await prisma.stockReservation.updateMany({ where: { orderId: p.order.id }, data: { expiresAt: new Date(Date.now() + 2 * 60_000) } });
      await prisma.order.update({ where: { id: p.order.id }, data: { expiresAt: new Date(Date.now() + 2 * 60_000) } });

      const res = await pay(p.token, p.order.id).expect(200);

      const minutes = (new Date(res.body.expiresAt).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(19);
      expect(minutes).toBeLessThanOrEqual(20);
      const holds = await prisma.stockReservation.findMany({ where: { orderId: p.order.id } });
      expect(holds.every((h) => h.expiresAt.getTime() - Date.now() > 19 * 60_000)).toBe(true);
      expect((await orderRow(p.order.id)).expiresAt!.getTime() - Date.now()).toBeGreaterThan(19 * 60_000);
    });

    it('never shortens a longer hold', async () => {
      const p = await placePendingOrder(app, prisma); // starts with a 30 minute hold
      const before = (await orderRow(p.order.id)).expiresAt!;
      const res = await pay(p.token, p.order.id).expect(200);
      expect(new Date(res.body.expiresAt).getTime()).toBe(before.getTime());
    });

    it('caps the total hold at 2 hours after the order was placed, so Pay cannot be used to hoard stock', async () => {
      const p = await placePendingOrder(app, prisma);
      const placedAt = new Date(Date.now() - 110 * 60_000); // 1h50m ago: only 10 minutes of room left
      await prisma.order.update({ where: { id: p.order.id }, data: { createdAt: placedAt, expiresAt: new Date(Date.now() + 60_000) } });
      await prisma.stockReservation.updateMany({ where: { orderId: p.order.id }, data: { expiresAt: new Date(Date.now() + 60_000) } });

      const res = await pay(p.token, p.order.id).expect(200);

      const minutes = (new Date(res.body.expiresAt).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(9);
      expect(minutes).toBeLessThanOrEqual(10);
    });

    it('does not extend at all once the 2 hour cap has passed', async () => {
      const p = await placePendingOrder(app, prisma);
      const soon = new Date(Date.now() + 60_000);
      await prisma.order.update({ where: { id: p.order.id }, data: { createdAt: new Date(Date.now() - 3 * 3_600_000), expiresAt: soon } });
      await prisma.stockReservation.updateMany({ where: { orderId: p.order.id }, data: { expiresAt: soon } });
      await pay(p.token, p.order.id).expect(200);
      expect((await orderRow(p.order.id)).expiresAt!.getTime()).toBe(soon.getTime());
    });

    it('reports a provider outage as 502 and leaves no half-made payment behind', async () => {
      const p = await placePendingOrder(app, prisma);
      gateway.failCreateOrder = true;
      await pay(p.token, p.order.id).expect(502);
      expect(await prisma.payment.count({ where: { orderId: p.order.id } })).toBe(0);
      gateway.failCreateOrder = false;
      await pay(p.token, p.order.id).expect(200); // and it works once the provider is back
    });

    it('lets the customer retry after a failed attempt, on the same provider order', async () => {
      const s = await started();
      await webhook(failed(s.init.providerOrderId, 'pay_bad1'), { eventId: nextEvent() }).expect(200);
      expect((await paymentRow(s.order.id)).status).toBe('FAILED');

      const retry = (await pay(s.token, s.order.id).expect(200)).body;
      expect(retry.providerOrderId).toBe(s.init.providerOrderId);
      expect(gateway.createdOrders).toHaveLength(1);
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'CREATED', failureReason: null });
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('confirming from the browser (POST /payments/verify)', () => {
    const body = (init: { providerOrderId: string }, paymentId: string, signature?: string) => ({
      razorpay_order_id: init.providerOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature ?? gateway.signCheckout(init.providerOrderId, paymentId),
    });

    it('turns a validly signed payment into a paid order and a real sale', async () => {
      const s = await started({ quantity: 2 });
      const res = await verify(s.token, body(s.init, 'pay_1')).expect(200);

      expect(res.body.outcome).toBe('paid');
      expect(res.body.order).toMatchObject({ id: s.order.id, status: 'PAID', expiresAt: null, total: 119800 });
      expect(res.body.order.payment).toMatchObject({ status: 'CAPTURED' });

      const order = await orderRow(s.order.id);
      expect(order.status).toBe('PAID');
      expect(order.paidAt).not.toBeNull();
      expect(order.expiresAt).toBeNull();
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'CAPTURED', providerPaymentId: 'pay_1' });

      // the held stock became a sale
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 18, reserved: 0 });
      const sale = await prisma.stockMovement.findFirstOrThrow({ where: { orderId: s.order.id } });
      expect(sale).toMatchObject({ type: 'SALE', quantity: -2, variantId: s.variant.id });
      expect((await prisma.stockReservation.findFirstOrThrow({ where: { orderId: s.order.id } })).status).toBe('COMMITTED');
    });

    it('emails the customer a confirmation, once', async () => {
      const s = await started();
      await verify(s.token, body(s.init, 'pay_mail')).expect(200);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].to).toBe(s.email);
      expect(mailer.sent[0].subject).toBe(`Order #${s.order.number} confirmed`);
      expect(mailer.sent[0].text).toContain('Total paid: ₹649');
      expect(mailer.sent[0].text).toContain('CGST');
    });

    it('still marks the order paid if the confirmation email cannot be sent', async () => {
      const s = await started();
      mailer.fail = true;
      await verify(s.token, body(s.init, 'pay_nomail')).expect(200);
      expect((await orderRow(s.order.id)).status).toBe('PAID');
    });

    it('is safe to repeat: no double sale, no second email', async () => {
      const s = await started({ quantity: 2 });
      await verify(s.token, body(s.init, 'pay_rep')).expect(200);
      const again = await verify(s.token, body(s.init, 'pay_rep')).expect(200);
      expect(again.body.outcome).toBe('already_paid');
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 18, reserved: 0 });
      expect(await prisma.stockMovement.count({ where: { orderId: s.order.id, type: 'SALE' } })).toBe(1);
      expect(mailer.sent).toHaveLength(1);
    });

    it('handles the browser report and the webhook arriving at the same moment', async () => {
      const s = await started({ quantity: 2 });
      const [a, b, c] = await Promise.all([
        verify(s.token, body(s.init, 'pay_race')),
        webhook(captured(s.init.providerOrderId, 'pay_race', 119800), { eventId: nextEvent() }),
        verify(s.token, body(s.init, 'pay_race')),
      ]);
      expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 18, reserved: 0 });
      expect(await prisma.stockMovement.count({ where: { orderId: s.order.id, type: 'SALE' } })).toBe(1);
      expect(mailer.sent).toHaveLength(1);
      expect((await orderRow(s.order.id)).status).toBe('PAID');
    });

    it('rejects a forged or wrong signature and changes nothing', async () => {
      const s = await started();
      const res = await verify(s.token, body(s.init, 'pay_forged', 'deadbeef'.repeat(8))).expect(400);
      expect(res.body.message).toMatch(/verification failed/);
      expect((await orderRow(s.order.id)).status).toBe('PENDING');
      expect((await paymentRow(s.order.id)).status).toBe('CREATED');
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 20, reserved: 1 });
      expect(mailer.sent).toHaveLength(0);
    });

    it('rejects a signature made for a different payment id', async () => {
      const s = await started();
      const sigForOther = gateway.signCheckout(s.init.providerOrderId, 'pay_other');
      await verify(s.token, body(s.init, 'pay_mine', sigForOther)).expect(400);
      expect((await orderRow(s.order.id)).status).toBe('PENDING');
    });

    it('rejects a signature made for a different provider order', async () => {
      const a = await started();
      const b = await started();
      const sigForB = gateway.signCheckout(b.init.providerOrderId, 'pay_x');
      await verify(a.token, { razorpay_order_id: a.init.providerOrderId, razorpay_payment_id: 'pay_x', razorpay_signature: sigForB }).expect(400);
      expect((await orderRow(a.order.id)).status).toBe('PENDING');
    });

    it('will not let one customer confirm another customer’s payment (404)', async () => {
      const s = await started();
      const stranger = await registerCustomer(app);
      await verify(stranger, body(s.init, 'pay_steal')).expect(404);
      expect((await orderRow(s.order.id)).status).toBe('PENDING');
    });

    it('404s for an unknown provider order and 400s for missing fields; needs a login', async () => {
      const s = await started();
      await verify(s.token, { razorpay_order_id: 'order_nope', razorpay_payment_id: 'pay_1', razorpay_signature: 'x' }).expect(404);
      await verify(s.token, { razorpay_order_id: s.init.providerOrderId }).expect(400);
      await http().post('/api/v1/payments/verify').send(body(s.init, 'pay_1')).expect(401);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('webhooks (POST /webhooks/razorpay)', () => {
    describe('signature', () => {
      it('rejects a missing signature (401)', async () => {
        const s = await started();
        await webhook(captured(s.init.providerOrderId, 'pay_w', 64900), { signature: null }).expect(401);
        expect((await orderRow(s.order.id)).status).toBe('PENDING');
      });

      it('rejects a wrong signature (401)', async () => {
        const s = await started();
        await webhook(captured(s.init.providerOrderId, 'pay_w', 64900), { signature: 'a'.repeat(64) }).expect(401);
        expect((await orderRow(s.order.id)).status).toBe('PENDING');
      });

      it('rejects a body that was altered after signing (401)', async () => {
        const s = await started();
        const original = JSON.stringify(captured(s.init.providerOrderId, 'pay_w', 100)); // genuine: Rs 1
        const tampered = JSON.stringify(captured(s.init.providerOrderId, 'pay_w', 64900));
        await webhook({}, { body: tampered, signature: gateway.signWebhook(original) }).expect(401);
        expect((await orderRow(s.order.id)).status).toBe('PENDING');
      });

      it('rejects a signature made with the wrong secret (401)', async () => {
        const s = await started();
        const body = JSON.stringify(captured(s.init.providerOrderId, 'pay_w', 64900));
        const wrong = new FakeGateway();
        Object.defineProperty(wrong, 'webhookSecret', { value: 'attacker-secret' });
        await webhook({}, { body, signature: wrong.signWebhook(body) }).expect(401);
      });

      it('rejects unparsable JSON even when correctly signed (400)', async () => {
        const body = '{not json';
        await webhook({}, { body, signature: gateway.signWebhook(body) }).expect(400);
      });
    });

    describe('payment.captured', () => {
      it('confirms the order even though the browser never reported back', async () => {
        const s = await started({ quantity: 2 });
        const res = await webhook(captured(s.init.providerOrderId, 'pay_wh1', 119800), { eventId: nextEvent() }).expect(200);
        expect(res.body).toEqual({ received: true });
        expect((await orderRow(s.order.id)).status).toBe('PAID');
        expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 18, reserved: 0 });
        expect(mailer.sent).toHaveLength(1);
      });

      it('ignores a re-delivery of the same event', async () => {
        const s = await started({ quantity: 2 });
        const eventId = nextEvent();
        await webhook(captured(s.init.providerOrderId, 'pay_wh2', 119800), { eventId }).expect(200);
        const again = await webhook(captured(s.init.providerOrderId, 'pay_wh2', 119800), { eventId }).expect(200);
        expect(again.body).toEqual({ received: true, duplicate: true });
        expect(mailer.sent).toHaveLength(1);
        expect(await prisma.webhookEvent.count({ where: { id: eventId } })).toBe(1);
      });

      it('is idempotent even across different event ids for the same payment', async () => {
        const s = await started({ quantity: 2 });
        await webhook(captured(s.init.providerOrderId, 'pay_wh3', 119800), { eventId: nextEvent() }).expect(200);
        await webhook(captured(s.init.providerOrderId, 'pay_wh3', 119800), { eventId: nextEvent() }).expect(200);
        expect(await prisma.stockMovement.count({ where: { orderId: s.order.id, type: 'SALE' } })).toBe(1);
        expect(mailer.sent).toHaveLength(1);
      });

      it('works without an event id header (falls back to a hash of the body)', async () => {
        const s = await started();
        const payload = captured(s.init.providerOrderId, 'pay_wh4', 64900);
        await webhook(payload).expect(200);
        const again = await webhook(payload).expect(200);
        expect(again.body.duplicate).toBe(true);
      });

      it('refuses to mark an order paid when the amount does not match', async () => {
        const s = await started();
        await webhook(captured(s.init.providerOrderId, 'pay_wh5', 100), { eventId: nextEvent() }).expect(200);
        expect((await orderRow(s.order.id)).status).toBe('PENDING');
        const payment = await paymentRow(s.order.id);
        expect(payment.status).toBe('CREATED');
        expect(payment.failureReason).toMatch(/^amount_mismatch/);
        expect(mailer.sent).toHaveLength(0);
      });

      it('acknowledges a payment for an order we do not know (so the provider stops retrying)', async () => {
        const before = await prisma.order.count({ where: { status: 'PAID' } });
        await webhook(captured('order_unknown', 'pay_x', 100), { eventId: nextEvent() }).expect(200);
        expect(await prisma.order.count({ where: { status: 'PAID' } })).toBe(before);
      });

      it('returns an error (so the provider retries) when processing fails, and succeeds on the retry', async () => {
        const s = await started({ quantity: 2 });
        const eventId = nextEvent();
        const spy = jest.spyOn(app.get(PaymentsService), 'confirmPaid').mockRejectedValueOnce(new Error('database unavailable'));
        await webhook(captured(s.init.providerOrderId, 'pay_wh6', 119800), { eventId }).expect(500);
        expect(await prisma.webhookEvent.count({ where: { id: eventId } })).toBe(0); // not recorded, so the retry is processed
        expect((await orderRow(s.order.id)).status).toBe('PENDING');
        spy.mockRestore();

        await webhook(captured(s.init.providerOrderId, 'pay_wh6', 119800), { eventId }).expect(200);
        expect((await orderRow(s.order.id)).status).toBe('PAID');
      });
    });

    describe('payment.failed', () => {
      it('records the failure, keeps the order and its stock hold, and lets the customer try again', async () => {
        const s = await started();
        await webhook(failed(s.init.providerOrderId, 'pay_f1', 'Insufficient funds'), { eventId: nextEvent() }).expect(200);
        expect(await paymentRow(s.order.id)).toMatchObject({ status: 'FAILED', failureReason: 'Insufficient funds' });
        expect((await orderRow(s.order.id)).status).toBe('PENDING');
        expect((await level(s.variant.id, s.shop.id)).reserved).toBe(1);
      });

      it('can be followed by a successful attempt on the same order', async () => {
        const s = await started({ quantity: 2 });
        await webhook(failed(s.init.providerOrderId, 'pay_f2'), { eventId: nextEvent() }).expect(200);
        await webhook(captured(s.init.providerOrderId, 'pay_f3', 119800), { eventId: nextEvent() }).expect(200);
        expect((await orderRow(s.order.id)).status).toBe('PAID');
        expect((await paymentRow(s.order.id)).status).toBe('CAPTURED');
      });

      it('never downgrades a payment that already succeeded (events can arrive out of order)', async () => {
        const s = await paid();
        await webhook(failed(s.init.providerOrderId, 'pay_late_fail'), { eventId: nextEvent() }).expect(200);
        expect((await paymentRow(s.order.id)).status).toBe('CAPTURED');
        expect((await orderRow(s.order.id)).status).toBe('PAID');
      });
    });

    it('acknowledges events it does not act on', async () => {
      await webhook({ event: 'order.paid', payload: {} }, { eventId: nextEvent() }).expect(200);
      await webhook({ event: 'something.new', payload: {} }, { eventId: nextEvent() }).expect(200);
      await webhook({}, { eventId: nextEvent() }).expect(200);
    });

    it('is not blocked by the general rate limit', async () => {
      // the provider may deliver bursts; 30 quick calls must all be accepted
      const body = JSON.stringify({ event: 'ping', payload: {} });
      const sig = gateway.signWebhook(body);
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          http().post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).set('X-Razorpay-Event-Id', `burst_${Date.now()}_${i}`).send(body),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('payments that arrive after the order was cancelled or expired', () => {
    it('honours the payment when the stock is still available (order comes back to life)', async () => {
      const s = await started({ quantity: 2 });
      await authed('post', `/orders/${s.order.id}/cancel`, s.token).expect(200); // customer cancelled while the payment window was open
      expect((await level(s.variant.id, s.shop.id)).reserved).toBe(0);

      await webhook(captured(s.init.providerOrderId, 'pay_late1', 119800), { eventId: nextEvent() }).expect(200);

      expect((await orderRow(s.order.id)).status).toBe('PAID');
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 18, reserved: 0 });
      expect(gateway.refunds).toHaveLength(0);
      expect(mailer.sent.map((m) => m.subject)).toEqual([`Order #${s.order.number} confirmed`]);
    });

    it('honours a payment that lands after the hold expired and was cleaned up', async () => {
      const s = await started({ quantity: 2 });
      await expireHold(s.order.id);
      expect((await orderRow(s.order.id)).status).toBe('CANCELLED');

      await webhook(captured(s.init.providerOrderId, 'pay_late2', 119800), { eventId: nextEvent() }).expect(200);

      expect((await orderRow(s.order.id)).status).toBe('PAID');
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 18, reserved: 0 });
    });

    it('refunds automatically when the items sold out in the meantime', async () => {
      const s = await started({ quantity: 2 });
      await authed('post', `/orders/${s.order.id}/cancel`, s.token).expect(200);
      await prisma.stockLevel.update({ where: { variantId_locationId: { variantId: s.variant.id, locationId: s.shop.id } }, data: { onHand: 0 } }); // someone else bought them

      await webhook(captured(s.init.providerOrderId, 'pay_late3', 119800), { eventId: nextEvent() }).expect(200);

      expect((await orderRow(s.order.id)).status).toBe('CANCELLED');
      expect(gateway.refunds).toEqual([expect.objectContaining({ paymentId: 'pay_late3', amount: 119800 })]);
      const r = await prisma.refund.findFirstOrThrow({ where: { orderId: s.order.id } });
      expect(r).toMatchObject({ status: 'PROCESSED', amount: 119800, requestedBy: null });
      expect(r.reason).toMatch(/sold out/);
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'REFUNDED', refundedAmount: 119800 });
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 0, reserved: 0 }); // nothing was sold or held
      expect(mailer.sent.map((m) => m.subject)).toEqual([`Refund for order #${s.order.number}`]); // refund notice, no confirmation
    });

    it('refunds when only part of the quantity is still available, and holds nothing', async () => {
      const s = await started({ quantity: 3 });
      await authed('post', `/orders/${s.order.id}/cancel`, s.token).expect(200);
      await prisma.stockLevel.update({ where: { variantId_locationId: { variantId: s.variant.id, locationId: s.shop.id } }, data: { onHand: 2 } }); // 3 wanted, 2 left

      await webhook(captured(s.init.providerOrderId, 'pay_late4', 179700), { eventId: nextEvent() }).expect(200);

      expect(gateway.refunds).toHaveLength(1);
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 2, reserved: 0 }); // the 2 it briefly claimed were given back
      expect((await orderRow(s.order.id)).status).toBe('CANCELLED');
    });

    it('still queues the refund if the provider is down, and the retry job sends it later', async () => {
      const s = await started();
      await authed('post', `/orders/${s.order.id}/cancel`, s.token).expect(200);
      await prisma.stockLevel.update({ where: { variantId_locationId: { variantId: s.variant.id, locationId: s.shop.id } }, data: { onHand: 0 } });
      gateway.failRefundsRemaining = 1;

      await webhook(captured(s.init.providerOrderId, 'pay_late5', 64900), { eventId: nextEvent() }).expect(200); // webhook itself succeeds

      let r = await prisma.refund.findFirstOrThrow({ where: { orderId: s.order.id } });
      expect(r).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(r.lastError).toMatch(/provider is down/);
      expect((await paymentRow(s.order.id)).status).toBe('CAPTURED'); // money is still with us until the refund goes out

      // not due yet: it was just attempted
      expect(await app.get(RefundsService).retryPending()).toBe(0);
      // after the lease passes, the sweep picks it up
      await prisma.refund.update({ where: { id: r.id }, data: { claimedAt: new Date(Date.now() - 5 * 60_000) } });
      expect(await app.get(RefundsService).retryPending()).toBe(1);

      r = await prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
      expect(r).toMatchObject({ status: 'PROCESSED', attempts: 2, lastError: null });
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'REFUNDED', refundedAmount: 64900 });
      expect(gateway.refunds).toHaveLength(1);
    });

    it('gives up after repeated failures and flags the refund for a person to handle', async () => {
      const s = await started();
      await authed('post', `/orders/${s.order.id}/cancel`, s.token).expect(200);
      await prisma.stockLevel.update({ where: { variantId_locationId: { variantId: s.variant.id, locationId: s.shop.id } }, data: { onHand: 0 } });
      gateway.failRefundsRemaining = 1;
      await webhook(captured(s.init.providerOrderId, 'pay_late6', 64900), { eventId: nextEvent() }).expect(200);
      const r = await prisma.refund.findFirstOrThrow({ where: { orderId: s.order.id } });
      await prisma.refund.update({ where: { id: r.id }, data: { attempts: 7, claimedAt: new Date(Date.now() - 5 * 60_000) } });
      gateway.failRefundsRemaining = 1;

      await app.get(RefundsService).retryPending();

      expect((await prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('FAILED');
      expect(await app.get(RefundsService).retryPending()).toBe(0); // no longer retried
    });

    it('refunds a duplicate payment for an order that was already paid', async () => {
      const s = await paid({ quantity: 2 });
      const dup = await prisma.payment.create({
        data: { orderId: s.order.id, provider: 'razorpay', providerOrderId: 'order_dup_1', amount: 119800, status: 'CREATED' },
      });

      await webhook(captured('order_dup_1', 'pay_dup', 119800), { eventId: nextEvent() }).expect(200);

      expect((await orderRow(s.order.id)).status).toBe('PAID'); // untouched
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 18, reserved: 0 }); // not sold twice
      expect(gateway.refunds).toEqual([expect.objectContaining({ paymentId: 'pay_dup', amount: 119800 })]);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: dup.id } })).status).toBe('REFUNDED');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('refunds by an administrator (POST /admin/orders/:id/refund)', () => {
    it('needs an admin: logged out 401, customer 403, store staff 403', async () => {
      const s = await paid();
      await http().post(`/api/v1/admin/orders/${s.order.id}/refund`).send({ reason: 'test' }).expect(401);
      await refund(s.order.id, { reason: 'customer tries' }, s.token).expect(403);
      await refund(s.order.id, { reason: 'staff tries' }, await staffToken(app, prisma)).expect(403);
      expect(gateway.refunds).toHaveLength(0);
    });

    it('refunds the whole payment by default and marks the order refunded', async () => {
      const s = await paid({ quantity: 2 });
      mailer.sent = [];
      const res = await refund(s.order.id, { reason: 'Customer changed their mind' }).expect(200);

      expect(res.body).toMatchObject({ status: 'PROCESSED', amount: 119800, reason: 'Customer changed their mind' });
      expect(res.body.providerRefundId).toMatch(/^rfnd_fake/);
      expect(gateway.refunds).toEqual([{ id: res.body.providerRefundId, paymentId: s.paymentId, amount: 119800 }]);
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'REFUNDED', refundedAmount: 119800 });
      expect((await orderRow(s.order.id)).status).toBe('REFUNDED');
      expect(mailer.sent.map((m) => m.subject)).toEqual([`Refund for order #${s.order.number}`]);
      expect(mailer.sent[0].text).toContain('refunded ₹1,198');
      expect((await prisma.refund.findFirstOrThrow({ where: { orderId: s.order.id } })).requestedBy).not.toBeNull();
    });

    it('does not touch stock unless asked to restock', async () => {
      const s = await paid({ quantity: 2 });
      await refund(s.order.id, { reason: 'Goods lost in transit' }).expect(200);
      expect((await level(s.variant.id, s.shop.id)).onHand).toBe(18);
    });

    it('can put the items back on the shelf with a full refund', async () => {
      const s = await paid({ quantity: 2 });
      await refund(s.order.id, { reason: 'Returned unopened', restock: true }).expect(200);
      expect(await level(s.variant.id, s.shop.id)).toMatchObject({ onHand: 20, reserved: 0 });
      const back = await prisma.stockMovement.findFirstOrThrow({ where: { orderId: s.order.id, reason: 'RETURN' } });
      expect(back).toMatchObject({ type: 'ADJUSTMENT', quantity: 2, balanceAfter: 20 });
    });

    it('refuses to restock on a partial refund', async () => {
      const s = await paid({ quantity: 2 });
      await refund(s.order.id, { reason: 'Partial', amount: 10000, restock: true }).expect(409);
      expect((await level(s.variant.id, s.shop.id)).onHand).toBe(18);
      expect(gateway.refunds).toHaveLength(0);
    });

    it('supports partial refunds: the order stays paid until everything is returned', async () => {
      const s = await paid({ quantity: 2 }); // 119800
      await refund(s.order.id, { reason: 'Damaged item discount', amount: 30000 }).expect(200);
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'CAPTURED', refundedAmount: 30000 });
      expect((await orderRow(s.order.id)).status).toBe('PAID');

      const rest = await refund(s.order.id, { reason: 'Refund the rest' }).expect(200); // default = what is left
      expect(rest.body.amount).toBe(89800);
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'REFUNDED', refundedAmount: 119800 });
      expect((await orderRow(s.order.id)).status).toBe('REFUNDED');
    });

    it('never refunds more than was paid', async () => {
      const s = await paid(); // 64900
      await refund(s.order.id, { reason: 'Too much', amount: 64901 }).expect(409);
      await refund(s.order.id, { reason: 'Part', amount: 60000 }).expect(200);
      await refund(s.order.id, { reason: 'Too much again', amount: 4901 }).expect(409); // only 4900 left
      await refund(s.order.id, { reason: 'Exactly the rest', amount: 4900 }).expect(200);
      await refund(s.order.id, { reason: 'Nothing left' }).expect(409);
      expect(gateway.refunds.map((r) => r.amount)).toEqual([60000, 4900]);
    });

    it('two simultaneous full refunds produce exactly one refund', async () => {
      const s = await paid();
      const results = await Promise.all([
        refund(s.order.id, { reason: 'Double click one' }),
        refund(s.order.id, { reason: 'Double click two' }),
        refund(s.order.id, { reason: 'Double click three' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(gateway.refunds).toHaveLength(1);
      expect(await prisma.refund.count({ where: { orderId: s.order.id } })).toBe(1);
    });

    it('counts a refund that is still pending against what can be refunded', async () => {
      const s = await paid();
      gateway.failRefundsRemaining = 1;
      const first = await refund(s.order.id, { reason: 'Provider is down' }).expect(200);
      expect(first.body).toMatchObject({ status: 'PENDING' });
      expect(first.body.lastError).toMatch(/provider is down/);
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'CAPTURED', refundedAmount: 0 });

      await refund(s.order.id, { reason: 'Try again' }).expect(409); // the pending one already covers everything
    });

    it('only refunds orders that have a captured payment', async () => {
      const unpaid = await started();
      await refund(unpaid.order.id, { reason: 'Never paid' }).expect(409);
      await refund('does-not-exist', { reason: 'No such order' }).expect(409);
    });

    it.each([
      ['zero amount', { amount: 0 }],
      ['negative amount', { amount: -100 }],
      ['fractional amount', { amount: 10.5 }],
      ['missing reason', { reason: undefined }],
      ['too-short reason', { reason: 'no' }],
      ['non-boolean restock', { restock: 'yes' }],
    ])('rejects %s', async (_label, over: Record<string, unknown>) => {
      const s = await paid();
      await refund(s.order.id, { reason: 'Valid reason here', ...over }).expect(400);
      expect(gateway.refunds).toHaveLength(0);
    });

    it('accepts a provider that confirms the refund asynchronously ("pending")', async () => {
      const s = await paid();
      gateway.refundStatus = 'pending';
      const res = await refund(s.order.id, { reason: 'Slow bank' }).expect(200);
      expect(res.body.status).toBe('PROCESSED'); // accepted by the provider; the money is on its way
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('refunds reported by the provider (refund.processed webhook)', () => {
    it('records a refund made from the provider dashboard', async () => {
      const s = await paid({ quantity: 2 });
      mailer.sent = [];
      await webhook(refundProcessed('rfnd_dash_1', s.paymentId, 30000), { eventId: nextEvent() }).expect(200);

      const r = await prisma.refund.findUniqueOrThrow({ where: { providerRefundId: 'rfnd_dash_1' } });
      expect(r).toMatchObject({ status: 'PROCESSED', amount: 30000 });
      expect(r.reason).toMatch(/dashboard/);
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'CAPTURED', refundedAmount: 30000 });
      expect(mailer.sent).toHaveLength(1);
    });

    it('marks the order refunded when the dashboard refund covers everything', async () => {
      const s = await paid();
      await webhook(refundProcessed('rfnd_dash_2', s.paymentId, 64900), { eventId: nextEvent() }).expect(200);
      expect(await paymentRow(s.order.id)).toMatchObject({ status: 'REFUNDED', refundedAmount: 64900 });
      expect((await orderRow(s.order.id)).status).toBe('REFUNDED');
    });

    it('counts a refund once even if it is delivered repeatedly', async () => {
      const s = await paid();
      await webhook(refundProcessed('rfnd_dash_3', s.paymentId, 10000), { eventId: nextEvent() }).expect(200);
      await webhook(refundProcessed('rfnd_dash_3', s.paymentId, 10000), { eventId: nextEvent() }).expect(200);
      await webhook(refundProcessed('rfnd_dash_3', s.paymentId, 10000), { eventId: nextEvent() }).expect(200);
      expect((await paymentRow(s.order.id)).refundedAmount).toBe(10000);
      expect(await prisma.refund.count({ where: { orderId: s.order.id } })).toBe(1);
    });

    it('does not double-count a refund we sent ourselves when its webhook arrives afterwards', async () => {
      const s = await paid();
      const res = await refund(s.order.id, { reason: 'We refunded it', amount: 20000 }).expect(200);
      await webhook(refundProcessed(res.body.providerRefundId, s.paymentId, 20000), { eventId: nextEvent() }).expect(200);
      expect((await paymentRow(s.order.id)).refundedAmount).toBe(20000);
      expect(await prisma.refund.count({ where: { orderId: s.order.id } })).toBe(1);
    });

    it('matches the webhook to a refund that is mid-flight (webhook beats our own bookkeeping)', async () => {
      const s = await paid();
      const payment = await paymentRow(s.order.id);
      const inFlight = await prisma.refund.create({
        data: { paymentId: payment.id, orderId: s.order.id, amount: 15000, reason: 'In flight', claimedAt: new Date(), attempts: 1 },
      });

      await webhook(refundProcessed('rfnd_race_1', s.paymentId, 15000), { eventId: nextEvent() }).expect(200);

      expect(await prisma.refund.count({ where: { orderId: s.order.id } })).toBe(1); // no duplicate record
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: inFlight.id } })).toMatchObject({ status: 'PROCESSED', providerRefundId: 'rfnd_race_1' });
      expect((await paymentRow(s.order.id)).refundedAmount).toBe(15000);
    });

    it('ignores refunds for payments it does not know', async () => {
      await webhook(refundProcessed('rfnd_x', 'pay_unknown', 100), { eventId: nextEvent() }).expect(200);
      expect(await prisma.refund.count({ where: { providerRefundId: 'rfnd_x' } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('the finished order as the customer sees it', () => {
    it('shows as paid with a captured payment and can no longer be cancelled online', async () => {
      const s = await paid();
      const view = (await authed('get', `/orders/${s.order.id}`, s.token).expect(200)).body;
      expect(view).toMatchObject({ status: 'PAID', expiresAt: null, payment: { status: 'CAPTURED', provider: 'razorpay', amount: 64900 } });
      const cancel = await authed('post', `/orders/${s.order.id}/cancel`, s.token).expect(409);
      expect(cancel.body.message).toMatch(/can no longer be cancelled online/);
    });

    it('paid orders are never auto-cancelled when the hold would have expired', async () => {
      const s = await paid();
      expect(await app.get(OrdersService).expireUnpaid(new Date(Date.now() + 24 * 3_600_000))).not.toContain(s.order.id);
      expect((await orderRow(s.order.id)).status).toBe('PAID');
    });
  });
});

// -----------------------------------------------------------------------------------------------
describe('Payments in development test mode (built-in mock gateway)', () => {
  let app: NestExpressApplication;
  const prisma = new PrismaClient();
  const mailer = new FakeMailer();
  const authed = (method: 'get' | 'post', path: string, token: string) =>
    request(app.getHttpServer())[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const { MockGateway } = await import('../src/payments/mock.gateway');
    app = await createTestApp({ gateway: new MockGateway(), mailer });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('identifies itself as the mock provider so the storefront can show test buttons', async () => {
    const p = await placePendingOrder(app, prisma);
    const init = (await authed('post', `/orders/${p.order.id}/pay`, p.token).expect(200)).body;
    expect(init).toMatchObject({ provider: 'mock', keyId: 'mock_key', amount: 64900 });
    expect(init.providerOrderId).toMatch(/^order_mock_/);
  });

  it('simulating success pays the order exactly like a real payment would', async () => {
    const p = await placePendingOrder(app, prisma, { quantity: 2 });
    await authed('post', `/orders/${p.order.id}/pay`, p.token).expect(200);
    mailer.sent = [];

    const res = await authed('post', '/payments/simulate', p.token).send({ orderId: p.order.id, outcome: 'success' }).expect(200);

    expect(res.body.outcome).toBe('paid');
    expect(res.body.order.status).toBe('PAID');
    expect(await prisma.stockLevel.findUniqueOrThrow({ where: { variantId_locationId: { variantId: p.variant.id, locationId: p.shop.id } } }))
      .toMatchObject({ onHand: 18, reserved: 0 });
    expect(mailer.sent).toHaveLength(1);
  });

  it('simulating failure leaves the order unpaid and retryable, then success works', async () => {
    const p = await placePendingOrder(app, prisma);
    await authed('post', `/orders/${p.order.id}/pay`, p.token).expect(200);
    const failure = await authed('post', '/payments/simulate', p.token).send({ orderId: p.order.id, outcome: 'failure' }).expect(200);
    expect(failure.body).toMatchObject({ outcome: 'failed', order: { status: 'PENDING', payment: { status: 'FAILED' } } });

    await authed('post', `/orders/${p.order.id}/pay`, p.token).expect(200); // retry
    const ok = await authed('post', '/payments/simulate', p.token).send({ orderId: p.order.id, outcome: 'success' }).expect(200);
    expect(ok.body.order.status).toBe('PAID');
  });

  it('needs the payment to be started first', async () => {
    const p = await placePendingOrder(app, prisma);
    await authed('post', '/payments/simulate', p.token).send({ orderId: p.order.id, outcome: 'success' }).expect(409);
  });

  it('cannot be used on someone else’s order, or on an order that is already paid', async () => {
    const p = await placePendingOrder(app, prisma);
    await authed('post', `/orders/${p.order.id}/pay`, p.token).expect(200);
    const stranger = await registerCustomer(app);
    await authed('post', '/payments/simulate', stranger).send({ orderId: p.order.id, outcome: 'success' }).expect(409);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: p.order.id } })).status).toBe('PENDING');

    await authed('post', '/payments/simulate', p.token).send({ orderId: p.order.id, outcome: 'success' }).expect(200);
    await authed('post', '/payments/simulate', p.token).send({ orderId: p.order.id, outcome: 'success' }).expect(409);
  });

  it('validates the request', async () => {
    const p = await placePendingOrder(app, prisma);
    await authed('post', '/payments/simulate', p.token).send({ orderId: p.order.id, outcome: 'maybe' }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/payments/simulate').send({ orderId: p.order.id, outcome: 'success' }).expect(401);
  });

  it('does not exist at all when a real gateway is configured (404)', async () => {
    const real = await createTestApp({ gateway: new FakeGateway() });
    try {
      const p = await placePendingOrder(real, prisma);
      await request(real.getHttpServer()).post(`/api/v1/orders/${p.order.id}/pay`).set('Authorization', `Bearer ${p.token}`).expect(200);
      const res = await request(real.getHttpServer())
        .post('/api/v1/payments/simulate').set('Authorization', `Bearer ${p.token}`)
        .send({ orderId: p.order.id, outcome: 'success' });
      expect(res.status).toBe(404);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: p.order.id } })).status).toBe('PENDING');
    } finally {
      await real.close();
    }
  });
});
