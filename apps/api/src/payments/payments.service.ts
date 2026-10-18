import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { ReservationService } from '../inventory/reservation.service';
import { MAILER, Mailer } from '../mail/mailer';
import { EmailOrder, orderConfirmationEmail } from '../mail/templates';
import { orderInclude, toOrderView } from '../orders/order-view';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_GATEWAY, PaymentGateway } from './gateway';
import { RefundsService } from './refunds.service';

/** While a customer is paying, their stock hold is stretched to at least this long. */
const PAYMENT_WINDOW_MINUTES = 20;
/** ...but never beyond this long after the order was placed, so repeatedly clicking Pay cannot hold stock forever. */
const MAX_HOLD_HOURS = 2;

export type ConfirmResult = 'paid' | 'already_paid' | 'refund_queued' | 'ignored';

interface Confirmation {
  result: ConfirmResult;
  orderId?: string;
  refundId?: string;
}

@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationService,
    private readonly refunds: RefundsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  // ---------- starting a payment ----------

  /**
   * Creates (or returns the existing) payment for an unpaid order and gives the browser what it needs to
   * open the payment window. Calling it again returns the same provider order, never a second one.
   */
  async startPayment(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId }, include: { user: true } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.paymentMethod !== 'ONLINE') throw new BadRequestException('This order is not paid online');
    if (order.status === 'CANCELLED') throw new ConflictException('This order was cancelled. Please place a new order.');
    if (order.status !== 'PENDING') throw new ConflictException('This order has already been paid');
    if (order.expiresAt && order.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException('This order has expired. Please place a new order.');
    }

    const reusable = () =>
      this.prisma.payment.findFirst({
        where: { orderId, provider: this.gateway.name, status: { in: ['CREATED', 'FAILED'] } },
        orderBy: { createdAt: 'desc' },
      });

    let payment = await reusable();
    if (!payment) {
      // Talk to the provider outside any database transaction (it is a network call).
      const created = await this.gateway.createOrder({
        amount: order.total,
        receipt: `KOMA-${order.number}`,
        notes: { orderId: order.id, orderNumber: String(order.number) },
      });
      payment = await this.prisma.$transaction(async (tx) => {
        // Two simultaneous "Pay" clicks: the second waits here and then reuses the first one's payment.
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const existing = await tx.payment.findFirst({
          where: { orderId, provider: this.gateway.name, status: { in: ['CREATED', 'FAILED'] } },
          orderBy: { createdAt: 'desc' },
        });
        if (existing) return existing;
        return tx.payment.create({
          data: { orderId, provider: this.gateway.name, providerOrderId: created.id, amount: order.total, status: 'CREATED' },
        });
      });
    }
    if (payment.status === 'FAILED') {
      payment = await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'CREATED', failureReason: null } });
    }

    const expiresAt = await this.extendHold(order.id, order.createdAt);

    return {
      provider: this.gateway.name,
      keyId: this.gateway.publicKey,
      providerOrderId: payment.providerOrderId!,
      amount: payment.amount,
      currency: 'INR' as const,
      orderId: order.id,
      orderNumber: order.number,
      expiresAt,
      prefill: { name: order.user.name, email: order.user.email, contact: order.user.phone },
    };
  }

  private async extendHold(orderId: string, placedAt: Date): Promise<Date | null> {
    const until = new Date(Math.min(Date.now() + PAYMENT_WINDOW_MINUTES * 60_000, placedAt.getTime() + MAX_HOLD_HOURS * 3_600_000));
    if (until.getTime() <= Date.now()) return null;
    await this.reservations.extend(orderId, until);
    await this.prisma.order.updateMany({ where: { id: orderId, status: 'PENDING', expiresAt: { lt: until } }, data: { expiresAt: until } });
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { expiresAt: true } });
    return order?.expiresAt ?? null;
  }

  // ---------- confirming a payment ----------

  /**
   * The browser reports a finished payment. The signature proves the provider produced it, so this is the
   * fast path; the webhook confirms the same payment and reaches the same (idempotent) code.
   */
  async verifyCheckout(userId: string, input: { providerOrderId: string; providerPaymentId: string; signature: string }) {
    const payment = await this.prisma.payment.findFirst({
      where: { providerOrderId: input.providerOrderId, order: { userId } },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (!this.gateway.verifyCheckoutSignature(input.providerOrderId, input.providerPaymentId, input.signature)) {
      throw new BadRequestException('Payment verification failed');
    }
    const outcome = await this.confirmPaid({ providerOrderId: input.providerOrderId, providerPaymentId: input.providerPaymentId });
    return { outcome: outcome.result, order: await this.orderView(payment.orderId) };
  }

  /**
   * Money has been taken for a provider order. Safe to call any number of times, from the browser and
   * the webhook at once: the payment row is locked, and a captured payment is never processed twice.
   */
  async confirmPaid(input: { providerOrderId: string; providerPaymentId: string; amount?: number }): Promise<Confirmation> {
    const outcome = await this.prisma.$transaction(async (tx): Promise<Confirmation> => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Payment" WHERE "providerOrderId" = ${input.providerOrderId} FOR UPDATE`;
      if (!row) {
        this.log.warn(`Payment received for unknown provider order ${input.providerOrderId}`);
        return { result: 'ignored' };
      }
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: row.id } });
      if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED') {
        return { result: 'already_paid', orderId: payment.orderId };
      }
      if (input.amount !== undefined && input.amount !== payment.amount) {
        // Never mark an order paid for the wrong amount. Needs a human to look at it.
        this.log.error(`Amount mismatch on ${input.providerOrderId}: expected ${payment.amount}, provider reports ${input.amount}`);
        await tx.payment.update({
          where: { id: payment.id },
          data: { failureReason: `amount_mismatch: provider reported ${input.amount}, expected ${payment.amount}` },
        });
        return { result: 'ignored', orderId: payment.orderId };
      }

      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${payment.orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId }, include: { items: true } });

      // From here the money has been taken, whatever happens to the order.
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'CAPTURED', providerPaymentId: input.providerPaymentId, failureReason: null },
      });

      if (order.status !== 'PENDING' && order.status !== 'CANCELLED') {
        // The order was already paid by another payment: give this one back.
        const refund = await this.queueRefund(tx, payment.id, order.id, payment.amount, 'Duplicate payment for an order that was already paid');
        return { result: 'refund_queued', orderId: order.id, refundId: refund.id };
      }

      // Normal case: the hold is still active, so just turn it into a sale.
      let units = await this.reservations.commit(order.id, tx);
      if (units === 0) {
        // The hold expired (or the order was cancelled) before the money arrived. If the stock is still there,
        // honour the payment; if not, the customer gets their money back.
        try {
          await this.reservations.reserve(
            order.id,
            order.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
            { tx, locationId: order.pickupLocationId ?? undefined, ttlMinutes: 1 },
          );
          units = await this.reservations.commit(order.id, tx);
        } catch (e) {
          if (!(e instanceof ConflictException)) throw e;
        }
      }

      if (units > 0) {
        await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', paidAt: new Date(), expiresAt: null } });
        return { result: 'paid', orderId: order.id };
      }

      await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', expiresAt: null } });
      const refund = await this.queueRefund(tx, payment.id, order.id, payment.amount, 'Items sold out while your payment was being completed');
      return { result: 'refund_queued', orderId: order.id, refundId: refund.id };
    });

    // Things that talk to the outside world happen only after the database work is safely committed.
    if (outcome.result === 'paid' && outcome.orderId) await this.sendConfirmation(outcome.orderId);
    if (outcome.result === 'refund_queued' && outcome.refundId) {
      await this.refunds.process(outcome.refundId).catch((e) => this.log.error(`Refund ${outcome.refundId} not sent yet: ${e}`));
    }
    return outcome;
  }

  /** The provider says an attempt failed. The order stays unpaid and the customer may try again. */
  async markFailed(input: { providerOrderId: string; reason?: string }) {
    await this.prisma.payment.updateMany({
      where: { providerOrderId: input.providerOrderId, status: { in: ['CREATED', 'AUTHORIZED'] } },
      data: { status: 'FAILED', failureReason: (input.reason ?? 'Payment failed').slice(0, 300) },
    });
  }

  private queueRefund(tx: Prisma.TransactionClient, paymentId: string, orderId: string, amount: number, reason: string) {
    return tx.refund.create({ data: { paymentId, orderId, amount, reason } });
  }

  // ---------- webhooks ----------

  /**
   * Entry point for the provider's notifications. The webhook is the source of truth for payments: it
   * works even if the customer closed the tab before the browser could report back.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined, eventId: string | undefined) {
    if (!rawBody || !signature || !this.gateway.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    let event: WebhookPayload;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Malformed webhook body');
    }

    // The provider retries until it gets a 2xx, so the same event can arrive more than once.
    const id = eventId || createHash('sha256').update(rawBody).digest('hex');
    if (await this.prisma.webhookEvent.findUnique({ where: { id } })) return { received: true, duplicate: true };

    const payment = event.payload?.payment?.entity;
    const refund = event.payload?.refund?.entity;
    switch (event.event) {
      case 'payment.captured':
        if (payment?.order_id && payment.id) {
          await this.confirmPaid({ providerOrderId: payment.order_id, providerPaymentId: payment.id, amount: payment.amount });
        }
        break;
      case 'payment.failed':
        if (payment?.order_id) {
          await this.markFailed({ providerOrderId: payment.order_id, reason: payment.error_description });
        }
        break;
      case 'refund.processed':
        if (refund?.id && refund.payment_id && typeof refund.amount === 'number') {
          await this.refunds.recordProviderRefund({ providerRefundId: refund.id, providerPaymentId: refund.payment_id, amount: refund.amount });
        }
        break;
      default:
        break; // events we do not act on are acknowledged so the provider stops retrying
    }

    // Recorded only after successful handling: a failure above returns an error and the provider retries.
    try {
      await this.prisma.webhookEvent.create({ data: { id, provider: this.gateway.name } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
    return { received: true };
  }

  // ---------- development test mode ----------

  /** Test-mode only: pretend the customer paid (or failed to). Hidden entirely when a real gateway is in use. */
  async simulate(userId: string, orderId: string, outcome: 'success' | 'failure') {
    if (this.gateway.name !== 'mock') throw new NotFoundException();
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, order: { userId }, provider: 'mock', status: { in: ['CREATED', 'FAILED'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment?.providerOrderId) throw new ConflictException('Start the payment first');
    let result: ConfirmResult | 'failed';
    if (outcome === 'success') {
      result = (await this.confirmPaid({ providerOrderId: payment.providerOrderId, providerPaymentId: `pay_mock_${payment.id}` })).result;
    } else {
      await this.markFailed({ providerOrderId: payment.providerOrderId, reason: 'Simulated failure' });
      result = 'failed';
    }
    return { outcome: result, order: await this.orderView(orderId) };
  }

  // ---------- helpers ----------

  private async orderView(orderId: string) {
    return toOrderView(await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude }));
  }

  private async sendConfirmation(orderId: string) {
    try {
      const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, user: true } });
      if (!order.user.email) return;
      const data: EmailOrder = {
        number: order.number,
        fulfilment: order.fulfilment,
        items: order.items.map((i) => ({ title: i.title, quantity: i.quantity, lineTotal: i.unitPrice * i.quantity })),
        subtotal: order.subtotal,
        shippingFee: order.shippingFee,
        total: order.total,
        tax: order.tax as unknown as EmailOrder['tax'],
        shippingAddress: order.shippingAddress as Record<string, unknown>,
      };
      await this.mailer.send({ to: order.user.email, ...orderConfirmationEmail(order.user.name, data) });
    } catch (e) {
      // A mail problem must never undo or fail a payment that has already succeeded.
      this.log.error(`Could not send confirmation email for order ${orderId}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

interface WebhookPayload {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; amount?: number; error_description?: string } };
    refund?: { entity?: { id?: string; payment_id?: string; amount?: number } };
  };
}
