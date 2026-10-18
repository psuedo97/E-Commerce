import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CartService } from '../cart/cart.service';
import { OrdersService } from './orders.service';

/** Background housekeeping. Switched off in tests with DISABLE_JOBS=true. */
@Injectable()
export class OrdersScheduler {
  private readonly log = new Logger(OrdersScheduler.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly carts: CartService,
  ) {}

  @Interval(60_000)
  async cancelExpiredOrders() {
    if (process.env.DISABLE_JOBS === 'true') return;
    try {
      const ids = await this.orders.expireUnpaid();
      if (ids.length) this.log.log(`Cancelled ${ids.length} unpaid order(s) and released their stock`);
    } catch (e) {
      this.log.error('Expiring unpaid orders failed', e as Error);
    }
  }

  @Interval(60 * 60_000)
  async purgeAbandonedGuestCarts() {
    if (process.env.DISABLE_JOBS === 'true') return;
    try {
      const n = await this.carts.purgeStaleGuestCarts();
      if (n) this.log.log(`Removed ${n} abandoned guest cart(s)`);
    } catch (e) {
      this.log.error('Purging guest carts failed', e as Error);
    }
  }
}
