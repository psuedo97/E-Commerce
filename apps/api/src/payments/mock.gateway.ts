import { randomBytes } from 'crypto';
import { GatewayOrder, GatewayRefund, hmacHex, PaymentGateway, safeEqualHex } from './gateway';

const SECRET = 'mock-secret';

/**
 * Stand-in used for local development when no Razorpay keys are set (never in production, see
 * gateway.provider.ts). It moves no money. The storefront shows "simulate" buttons for it.
 */
export class MockGateway implements PaymentGateway {
  readonly name = 'mock' as const;
  readonly publicKey = 'mock_key';

  async createOrder(): Promise<GatewayOrder> {
    return { id: `order_mock_${randomBytes(8).toString('hex')}` };
  }

  verifyCheckoutSignature(providerOrderId: string, providerPaymentId: string, signature: string): boolean {
    return safeEqualHex(hmacHex(SECRET, `${providerOrderId}|${providerPaymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    return safeEqualHex(hmacHex(SECRET, rawBody), signature);
  }

  async refund(): Promise<GatewayRefund> {
    return { id: `rfnd_mock_${randomBytes(8).toString('hex')}`, status: 'processed' };
  }
}
