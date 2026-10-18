import { Logger, Provider, ServiceUnavailableException } from '@nestjs/common';
import { GatewayOrder, GatewayRefund, PAYMENT_GATEWAY, PaymentGateway } from './gateway';
import { MockGateway } from './mock.gateway';
import { RazorpayGateway } from './razorpay.gateway';

/** Used in production when keys are missing: every payment action fails loudly instead of "succeeding". */
class UnconfiguredGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;
  readonly publicKey = '';
  private fail(): never {
    throw new ServiceUnavailableException('Online payments are not configured');
  }
  // async, so a failure is always a rejected promise, the same as the real gateways
  async createOrder(): Promise<GatewayOrder> { return this.fail(); }
  verifyCheckoutSignature(): boolean { return false; }
  verifyWebhookSignature(): boolean { return false; }
  async refund(): Promise<GatewayRefund> { return this.fail(); }
}

export function chooseGateway(env: NodeJS.ProcessEnv = process.env): PaymentGateway {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (keyId && keySecret) return new RazorpayGateway(keyId, keySecret, env.RAZORPAY_WEBHOOK_SECRET || undefined);
  // The test-mode gateway moves no money, so it must never be reachable in production.
  if (env.NODE_ENV === 'production') return new UnconfiguredGateway();
  new Logger('Payments').warn('No Razorpay keys set: using the built-in test-mode payment gateway (no real money).');
  return new MockGateway();
}

export const gatewayProvider: Provider = { provide: PAYMENT_GATEWAY, useFactory: () => chooseGateway() };
