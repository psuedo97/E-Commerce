import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RefundsService } from './refunds.service';

/** Retries refunds that could not be sent the first time. Switched off in tests with DISABLE_JOBS=true. */
@Injectable()
export class PaymentsScheduler {
  private readonly log = new Logger(PaymentsScheduler.name);

  constructor(private readonly refunds: RefundsService) {}

  @Interval(5 * 60_000)
  async retryRefunds() {
    if (process.env.DISABLE_JOBS === 'true') return;
    try {
      const n = await this.refunds.retryPending();
      if (n) this.log.log(`Retried ${n} pending refund(s)`);
    } catch (e) {
      this.log.error('Retrying refunds failed', e as Error);
    }
  }
}
