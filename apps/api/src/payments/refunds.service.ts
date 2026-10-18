import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, Refund } from '@prisma/client';
import { InventoryService } from '../inventory/inventory.service';
import { MAILER, Mailer } from '../mail/mailer';
import { refundEmail } from '../mail/templates';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_GATEWAY, PaymentGateway } from './gateway';

/** After this many failed attempts a refund is marked FAILED and needs a person (check the provider dashboard). */
const MAX_ATTEMPTS = 8;
/** A refund being sent is "leased" for this long; if the worker dies, another one may retry afterwards. */
const LEASE_MINUTES = 2;

export interface RefundRequest {
  amount?: number; // paise; defaults to everything still refundable
  reason: string;
  restock?: boolean; // full refunds only: put the items back on the shelf
}

@Injectable()
export class RefundsService {
  private readonly log = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /** Staff-initiated refund of a paid order. Creates the refund, then sends it to the provider. */
  async refundOrder(adminId: string, orderId: string, req: RefundRequest) {
    const refund = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Payment" WHERE "orderId" = ${orderId} AND status = 'CAPTURED' FOR UPDATE`;
      if (!row) throw new ConflictException('This order has no captured payment to refund');
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: row.id } });

      // Refunds already requested but not yet confirmed also count against what is left.
      const inFlight = await tx.refund.aggregate({ where: { paymentId: payment.id, status: 'PENDING' }, _sum: { amount: true } });
      const remaining = payment.amount - payment.refundedAmount - (inFlight._sum.amount ?? 0);
      if (remaining <= 0) throw new ConflictException('This payment has already been fully refunded');
      const amount = req.amount ?? remaining;
      if (amount > remaining) throw new ConflictException(`Only ${remaining} paise can still be refunded`);

      if (req.restock && amount !== payment.amount) {
        throw new ConflictException('Restocking is only available when refunding the whole order');
      }
      if (req.restock) await this.inventory.restockOrder(tx, orderId, adminId);

      return tx.refund.create({
        data: { paymentId: payment.id, orderId, amount, reason: req.reason, requestedBy: adminId },
      });
    });
    return this.process(refund.id);
  }

  /** Sends one pending refund to the provider. Safe to call repeatedly or from several workers. */
  async process(refundId: string): Promise<Refund> {
    const leaseExpired = new Date(Date.now() - LEASE_MINUTES * 60_000);
    // One atomic statement: only a single caller can take the lease on a refund.
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Refund" SET attempts = attempts + 1, "claimedAt" = NOW(), "updatedAt" = NOW()
      WHERE id = ${refundId} AND status = 'PENDING'
        AND ("claimedAt" IS NULL OR "claimedAt" < ${leaseExpired})
      RETURNING id`;
    const refund = await this.prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
    if (claimed.length === 0) return refund; // done already, or another worker has it

    try {
      if (!refund.payment.providerPaymentId) throw new Error('Payment has no provider payment id');
      const result = await this.gateway.refund(refund.payment.providerPaymentId, refund.amount, { refundId: refund.id });
      await this.finalize(refund.id, result.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn(`Refund ${refund.id} attempt ${refund.attempts} failed: ${message}`);
      await this.prisma.refund.updateMany({
        where: { id: refund.id, status: 'PENDING' },
        data: { lastError: message.slice(0, 500), ...(refund.attempts >= MAX_ATTEMPTS ? { status: 'FAILED' } : {}) },
      });
    }
    return this.prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  /** Background sweep: retries refunds that could not be sent earlier. Returns how many were attempted. */
  async retryPending(): Promise<number> {
    const due = await this.prisma.refund.findMany({
      where: {
        status: 'PENDING',
        OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(Date.now() - LEASE_MINUTES * 60_000) } }],
      },
      select: { id: true },
      take: 50,
    });
    for (const { id } of due) await this.process(id);
    return due.length;
  }

  /**
   * The provider says a refund went through ("refund.processed" webhook). Matches it to our record,
   * or records it if it was made from the provider's dashboard.
   */
  async recordProviderRefund(input: { providerRefundId: string; providerPaymentId: string; amount: number }) {
    const known = await this.prisma.refund.findUnique({ where: { providerRefundId: input.providerRefundId } });
    if (known) return; // we already have it (we sent it, or this webhook was delivered before)

    const payment = await this.prisma.payment.findUnique({ where: { providerPaymentId: input.providerPaymentId } });
    if (!payment) return;

    // Our own refund whose confirmation raced the webhook: same payment and amount, currently being sent.
    const inFlight = await this.prisma.refund.findFirst({
      where: { paymentId: payment.id, status: 'PENDING', amount: input.amount, claimedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (inFlight) {
      await this.finalize(inFlight.id, input.providerRefundId);
      return;
    }

    try {
      const created = await this.prisma.refund.create({
        data: {
          paymentId: payment.id, orderId: payment.orderId, amount: input.amount, status: 'PENDING',
          reason: 'Refunded from the payment provider dashboard', providerRefundId: input.providerRefundId,
        },
      });
      await this.finalize(created.id, input.providerRefundId);
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e; // a concurrent delivery got there first
    }
  }

  /**
   * Marks a refund as done and updates the payment and order. The PENDING -> PROCESSED flip is the guard:
   * whichever path wins it (our own call or the webhook) counts the money exactly once.
   */
  private async finalize(refundId: string, providerRefundId: string): Promise<void> {
    const done = await this.prisma.$transaction(async (tx) => {
      const won = await tx.refund.updateMany({
        where: { id: refundId, status: 'PENDING' },
        data: { status: 'PROCESSED', providerRefundId, lastError: null },
      });
      if (won.count === 0) return null;
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      const payment = await tx.payment.update({
        where: { id: refund.paymentId },
        data: { refundedAmount: { increment: refund.amount } },
      });
      if (payment.refundedAmount >= payment.amount) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });
      }
      // The order counts as refunded only when ALL the money taken for it has gone back. (Refunding a
      // duplicate payment must not mark an order refunded while the customer's real payment still stands.)
      const totals = await tx.payment.aggregate({
        where: { orderId: refund.orderId, status: { in: ['CAPTURED', 'REFUNDED'] } },
        _sum: { amount: true, refundedAmount: true },
      });
      if ((totals._sum.refundedAmount ?? 0) >= (totals._sum.amount ?? 0)) {
        // A cancelled order (e.g. refunded because it sold out) stays cancelled; paid orders become refunded.
        await tx.order.updateMany({ where: { id: refund.orderId, status: { notIn: ['CANCELLED', 'REFUNDED'] } }, data: { status: 'REFUNDED' } });
      }
      return refund;
    });
    if (done) await this.notify(done.orderId, done.amount, done.reason);
  }

  private async notify(orderId: string, amount: number, reason: string) {
    try {
      const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
      if (!order?.user.email) return;
      await this.mailer.send({ to: order.user.email, ...refundEmail(order.user.name, order.number, amount, reason) });
    } catch (e) {
      this.log.error(`Could not send refund email for order ${orderId}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
