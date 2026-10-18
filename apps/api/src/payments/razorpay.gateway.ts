import { BadGatewayException } from '@nestjs/common';
import { GatewayOrder, GatewayRefund, hmacHex, PaymentGateway, safeEqualHex } from './gateway';

type FetchLike = typeof fetch;

const API = 'https://api.razorpay.com/v1';

/**
 * Razorpay over its REST API (no SDK needed). `fetchImpl` is injectable so the request format can be
 * tested without network access.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get publicKey() {
    return this.keyId;
  }

  async createOrder(params: { amount: number; receipt: string; notes?: Record<string, string> }): Promise<GatewayOrder> {
    const data = await this.call<{ id: string }>('POST', '/orders', {
      amount: params.amount,
      currency: 'INR',
      receipt: params.receipt,
      notes: params.notes ?? {},
    });
    return { id: data.id };
  }

  verifyCheckoutSignature(providerOrderId: string, providerPaymentId: string, signature: string): boolean {
    return safeEqualHex(hmacHex(this.keySecret, `${providerOrderId}|${providerPaymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
    if (!this.webhookSecret) return false; // never accept webhooks we cannot verify
    return safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature);
  }

  async refund(providerPaymentId: string, amount: number, notes?: Record<string, string>): Promise<GatewayRefund> {
    const data = await this.call<{ id: string; status: string }>('POST', `/payments/${providerPaymentId}/refund`, {
      amount,
      notes: notes ?? {},
    });
    return { id: data.id, status: data.status === 'processed' ? 'processed' : 'pending' };
  }

  private async call<T>(method: 'POST' | 'GET', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BadGatewayException('The payment provider could not be reached');
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: { description?: string } } | null;
      throw new BadGatewayException(err?.error?.description ?? `The payment provider returned an error (${res.status})`);
    }
    return (await res.json()) as T;
  }
}
