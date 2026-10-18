import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ReservationService } from '../inventory/reservation.service';
import { PrismaService } from '../prisma/prisma.service';
import { orderInclude, toOrderView } from './order-view';
import { ListOrdersQuery } from './orders.dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationService,
  ) {}

  async list(userId: string, q: ListOrdersQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 10;
    const where = { userId };
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: orderInclude,
      }),
    ]);
    return { items: rows.map(toOrderView), page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) };
  }

  /** Someone else's order id looks exactly like a missing one (404). */
  async get(userId: string, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, userId }, include: orderInclude });
    if (!order) throw new NotFoundException('Order not found');
    return toOrderView(order);
  }

  /** Customers can cancel only unpaid orders. Paid orders go through refunds (a later phase). */
  async cancel(userId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      // The status check is part of the UPDATE, so cancel and payment cannot both win.
      const won = await tx.order.updateMany({ where: { id, userId, status: 'PENDING' }, data: { status: 'CANCELLED', expiresAt: null } });
      if (won.count === 0) {
        const order = await tx.order.findFirst({ where: { id, userId } });
        if (!order) throw new NotFoundException('Order not found');
        throw new ConflictException(
          order.status === 'CANCELLED' ? 'This order is already cancelled' : 'This order can no longer be cancelled online. Please contact us.',
        );
      }
      await this.reservations.release(id, tx);
    });
    return this.get(userId, id);
  }

  /**
   * Cancels unpaid orders whose stock hold has run out and returns their ids.
   * Called every minute by the scheduler.
   */
  async expireUnpaid(now = new Date()): Promise<string[]> {
    const expired = await this.reservations.releaseExpired(now);
    if (expired.length === 0) return [];
    await this.prisma.order.updateMany({
      where: { id: { in: expired }, status: 'PENDING' },
      data: { status: 'CANCELLED', expiresAt: null },
    });
    return expired;
  }
}
