import { BadGatewayException } from '@nestjs/common';
import { Email, Mailer } from '../src/mail/mailer';
import { GatewayOrder, GatewayRefund, hmacHex, PaymentGateway, safeEqualHex } from '../src/payments/gateway';

/**
 * A payment provider the tests fully control: it signs and verifies exactly like Razorpay (HMAC-SHA256),
 * records what it was asked to do, and can be told to fail.
 */
export class FakeGateway implements PaymentGateway {
  name: 'razorpay' | 'mock' = 'razorpay';
  readonly publicKey = 'rzp_test_fake';
  readonly keySecret = 'fake-key-secret';
  readonly webhookSecret = 'fake-webhook-secret';

  createdOrders: { id: string; amount: number; receipt: string; notes?: Record<string, string> }[] = [];
  refunds: { id: string; paymentId: string; amount: number }[] = [];
  failCreateOrder = false;
  failRefundsRemaining = 0;
  refundStatus: 'processed' | 'pending' = 'processed';
  private orderSeq = 0;
  private refundSeq = 0;

  async createOrder(p: { amount: number; receipt: string; notes?: Record<string, string> }): Promise<GatewayOrder> {
    if (this.failCreateOrder) throw new BadGatewayException('Payment provider is down');
    const id = `order_fake_${++this.orderSeq}_${Math.random().toString(36).slice(2, 8)}`;
    this.createdOrders.push({ ...p, id });
    return { id };
  }

  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string) {
    return safeEqualHex(this.signCheckout(orderId, paymentId), signature);
  }

  verifyWebhookSignature(rawBody: Buffer | string, signature: string) {
    return safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature);
  }

  async refund(paymentId: string, amount: number): Promise<GatewayRefund> {
    if (this.failRefundsRemaining > 0) {
      this.failRefundsRemaining--;
      throw new BadGatewayException('Payment provider is down');
    }
    const id = `rfnd_fake_${++this.refundSeq}_${Math.random().toString(36).slice(2, 8)}`;
    this.refunds.push({ id, paymentId, amount });
    return { id, status: this.refundStatus };
  }

  // helpers for tests
  signCheckout = (orderId: string, paymentId: string) => hmacHex(this.keySecret, `${orderId}|${paymentId}`);
  signWebhook = (body: string) => hmacHex(this.webhookSecret, body);
}

export class FakeMailer implements Mailer {
  sent: Email[] = [];
  fail = false;
  async send(email: Email) {
    if (this.fail) throw new Error('mail server down');
    this.sent.push(email);
  }
}
