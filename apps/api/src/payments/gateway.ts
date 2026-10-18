import { createHmac, timingSafeEqual } from 'crypto';

/** Injection token for whichever payment provider is configured. */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export interface GatewayOrder {
  id: string; // the provider's order id, e.g. Razorpay "order_..."
}

export interface GatewayRefund {
  id: string;
  /** "pending" means the provider accepted it and will finish later; a webhook confirms it. */
  status: 'processed' | 'pending';
}

export interface PaymentGateway {
  readonly name: 'razorpay' | 'mock';
  /** The publishable key the browser needs to open the payment window (not a secret). */
  readonly publicKey: string;
  /** Amounts are integers in paise. */
  createOrder(params: { amount: number; receipt: string; notes?: Record<string, string> }): Promise<GatewayOrder>;
  /** Checks the proof the browser sends back after a successful payment. */
  verifyCheckoutSignature(providerOrderId: string, providerPaymentId: string, signature: string): boolean;
  /** Checks that a webhook really came from the provider. Needs the raw, unparsed request body. */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean;
  refund(providerPaymentId: string, amount: number, notes?: Record<string, string>): Promise<GatewayRefund>;
}

export const hmacHex = (secret: string, data: Buffer | string) =>
  createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time comparison, so a wrong signature cannot be guessed from response timing. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
