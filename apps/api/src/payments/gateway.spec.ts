import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { hmacHex, safeEqualHex } from './gateway';
import { chooseGateway } from './gateway.provider';
import { MockGateway } from './mock.gateway';
import { RazorpayGateway } from './razorpay.gateway';

// Signatures computed independently with Node's crypto (not with the code under test).
const CHECKOUT_SIG = '52115a0d3400de9e86aade1f1b6eba9e8974604f4e267a9e9a16633a4c8dd2cb'; // HMAC-SHA256("secret", "order_1|pay_1")
const WEBHOOK_BODY = '{"event":"payment.captured"}';
const WEBHOOK_SIG = '4673dd707ef4c41b987cb7fefe1583142dc702388c93145b7814b9ad3d3c183e'; // HMAC-SHA256("whsec", body)

describe('hmacHex / safeEqualHex', () => {
  it('matches a known HMAC-SHA256 value', () => {
    expect(hmacHex('secret', 'order_1|pay_1')).toBe(CHECKOUT_SIG);
  });

  it('compares equal strings as equal and anything else as different', () => {
    expect(safeEqualHex('abc123', 'abc123')).toBe(true);
    expect(safeEqualHex('abc123', 'abc124')).toBe(false);
    expect(safeEqualHex('abc123', 'abc12')).toBe(false); // different length: must not throw
    expect(safeEqualHex('', 'x')).toBe(false);
    expect(safeEqualHex('', '')).toBe(true);
  });
});

function fakeFetch(respond: (url: string, init: RequestInit) => { status?: number; json?: unknown } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const out = respond(url, init);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out.json ?? {}), { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('RazorpayGateway', () => {
  // `null` means "no webhook secret configured" (undefined would trigger the default value here).
  const make = (f: typeof fetch, webhookSecret: string | null = 'whsec') =>
    new RazorpayGateway('rzp_test_KEY', 'secret', webhookSecret ?? undefined, f);

  describe('createOrder', () => {
    it('calls the Orders API with basic auth, INR and the amount in paise', async () => {
      const { impl, calls } = fakeFetch(() => ({ json: { id: 'order_ABC', amount: 64900 } }));
      const out = await make(impl).createOrder({ amount: 64900, receipt: 'KOMA-1042', notes: { orderId: 'o1' } });

      expect(out).toEqual({ id: 'order_ABC' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.razorpay.com/v1/orders');
      expect(calls[0].init.method).toBe('POST');
      const headers = calls[0].init.headers as Record<string, string>;
      expect(Buffer.from(headers.Authorization.replace('Basic ', ''), 'base64').toString()).toBe('rzp_test_KEY:secret');
      expect(headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ amount: 64900, currency: 'INR', receipt: 'KOMA-1042', notes: { orderId: 'o1' } });
    });

    it('maps a provider error to a 502 with the provider’s explanation', async () => {
      const { impl } = fakeFetch(() => ({ status: 400, json: { error: { description: 'Amount must be at least INR 1.00' } } }));
      const err = await make(impl).createOrder({ amount: 10, receipt: 'r' }).catch((e) => e);
      expect(err).toBeInstanceOf(BadGatewayException);
      expect(err.message).toBe('Amount must be at least INR 1.00');
    });

    it('gives a generic 502 when the provider’s error has no details', async () => {
      const { impl } = fakeFetch(() => ({ status: 500 }));
      await expect(make(impl).createOrder({ amount: 100, receipt: 'r' })).rejects.toThrow(/returned an error \(500\)/);
    });

    it('turns a network failure into a 502', async () => {
      const { impl } = fakeFetch(() => new Error('ECONNRESET'));
      const err = await make(impl).createOrder({ amount: 100, receipt: 'r' }).catch((e) => e);
      expect(err).toBeInstanceOf(BadGatewayException);
      expect(err.message).toMatch(/could not be reached/);
    });
  });

  describe('refund', () => {
    it('posts to the payment’s refund endpoint with the amount in paise', async () => {
      const { impl, calls } = fakeFetch(() => ({ json: { id: 'rfnd_1', status: 'processed' } }));
      const out = await make(impl).refund('pay_9', 12000, { refundId: 'r1' });
      expect(out).toEqual({ id: 'rfnd_1', status: 'processed' });
      expect(calls[0].url).toBe('https://api.razorpay.com/v1/payments/pay_9/refund');
      expect(JSON.parse(calls[0].init.body as string)).toEqual({ amount: 12000, notes: { refundId: 'r1' } });
    });

    it.each([['processed', 'processed'], ['pending', 'pending'], ['created', 'pending'], ['anything-else', 'pending']])(
      'maps provider status "%s" to "%s"',
      async (providerStatus, expected) => {
        const { impl } = fakeFetch(() => ({ json: { id: 'rfnd_2', status: providerStatus } }));
        expect((await make(impl).refund('pay_1', 100)).status).toBe(expected);
      },
    );

    it('surfaces provider errors (e.g. payment already fully refunded) as 502', async () => {
      const { impl } = fakeFetch(() => ({ status: 400, json: { error: { description: 'The payment has been fully refunded already' } } }));
      await expect(make(impl).refund('pay_1', 100)).rejects.toThrow('fully refunded already');
    });
  });

  describe('signatures', () => {
    const g = make(fakeFetch(() => ({})).impl);

    it('accepts the correct checkout signature', () => {
      expect(g.verifyCheckoutSignature('order_1', 'pay_1', CHECKOUT_SIG)).toBe(true);
    });

    it.each([
      ['a different payment id', 'order_1', 'pay_2', CHECKOUT_SIG],
      ['a different order id', 'order_2', 'pay_1', CHECKOUT_SIG],
      ['a wrong signature', 'order_1', 'pay_1', 'f'.repeat(64)],
      ['an empty signature', 'order_1', 'pay_1', ''],
      ['an upper-cased signature', 'order_1', 'pay_1', CHECKOUT_SIG.toUpperCase()],
    ])('rejects %s', (_l, o, p, sig) => {
      expect(g.verifyCheckoutSignature(o, p, sig)).toBe(false);
    });

    it('accepts the correct webhook signature, whether the body is a string or raw bytes', () => {
      expect(g.verifyWebhookSignature(WEBHOOK_BODY, WEBHOOK_SIG)).toBe(true);
      expect(g.verifyWebhookSignature(Buffer.from(WEBHOOK_BODY), WEBHOOK_SIG)).toBe(true);
    });

    it('rejects a webhook whose body differs by even one character (e.g. re-serialised JSON)', () => {
      expect(g.verifyWebhookSignature('{"event": "payment.captured"}', WEBHOOK_SIG)).toBe(false);
      expect(g.verifyWebhookSignature(WEBHOOK_BODY + ' ', WEBHOOK_SIG)).toBe(false);
    });

    it('never accepts webhooks when no webhook secret is configured', () => {
      const noSecret = make(fakeFetch(() => ({})).impl, null);
      expect(noSecret.verifyWebhookSignature(WEBHOOK_BODY, WEBHOOK_SIG)).toBe(false);
      expect(noSecret.verifyWebhookSignature(WEBHOOK_BODY, hmacHex('', WEBHOOK_BODY))).toBe(false); // even a signature made with an empty key
    });

    it('does not mix up the key secret and the webhook secret', () => {
      expect(g.verifyWebhookSignature('order_1|pay_1', CHECKOUT_SIG)).toBe(false);
      expect(g.verifyCheckoutSignature('x', 'y', hmacHex('whsec', 'x|y'))).toBe(false);
    });
  });

  it('exposes only the publishable key id', () => {
    expect(make(fakeFetch(() => ({})).impl).publicKey).toBe('rzp_test_KEY');
  });
});

describe('MockGateway', () => {
  const g = new MockGateway();

  it('creates unique order ids that identify themselves as mock', async () => {
    const [a, b] = [await g.createOrder(), await g.createOrder()];
    expect(a.id).toMatch(/^order_mock_[0-9a-f]{16}$/);
    expect(a.id).not.toBe(b.id);
  });

  it('verifies its own signatures and nothing else', () => {
    expect(g.verifyCheckoutSignature('o', 'p', hmacHex('mock-secret', 'o|p'))).toBe(true);
    expect(g.verifyCheckoutSignature('o', 'p', hmacHex('other', 'o|p'))).toBe(false);
    expect(g.verifyWebhookSignature('body', hmacHex('mock-secret', 'body'))).toBe(true);
    expect(g.verifyWebhookSignature('body', 'nope')).toBe(false);
  });

  it('refunds instantly', async () => {
    expect(await g.refund()).toMatchObject({ status: 'processed', id: expect.stringMatching(/^rfnd_mock_/) });
  });
});

describe('chooseGateway', () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

  it('uses Razorpay when both keys are set', () => {
    const g = chooseGateway(env({ RAZORPAY_KEY_ID: 'rzp_live_X', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' }));
    expect(g).toBeInstanceOf(RazorpayGateway);
    expect(g.publicKey).toBe('rzp_live_X');
  });

  it('uses Razorpay in production too, when configured', () => {
    expect(chooseGateway(env({ NODE_ENV: 'production', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's' }))).toBeInstanceOf(RazorpayGateway);
  });

  it('falls back to the test-mode gateway in development with no keys', () => {
    expect(chooseGateway(env({}))).toBeInstanceOf(MockGateway);
    expect(chooseGateway(env({ NODE_ENV: 'development' }))).toBeInstanceOf(MockGateway);
  });

  it('treats a half-configured key pair as not configured', () => {
    expect(chooseGateway(env({ RAZORPAY_KEY_ID: 'k' }))).toBeInstanceOf(MockGateway);
    expect(chooseGateway(env({ RAZORPAY_KEY_SECRET: 's' }))).toBeInstanceOf(MockGateway);
    expect(chooseGateway(env({ RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' }))).toBeInstanceOf(MockGateway);
  });

  describe('in production without keys it must never fall back to the test-mode gateway', () => {
    const g = chooseGateway(env({ NODE_ENV: 'production' }));

    it('is not the mock gateway', () => {
      expect(g).not.toBeInstanceOf(MockGateway);
      expect(g.name).not.toBe('mock');
    });

    it('refuses to create payments or refunds (503)', async () => {
      await expect(g.createOrder({ amount: 100, receipt: 'r' })).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(g.refund('pay_1', 100)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('accepts no signatures at all', () => {
      expect(g.verifyCheckoutSignature('o', 'p', hmacHex('', 'o|p'))).toBe(false);
      expect(g.verifyWebhookSignature('x', hmacHex('', 'x'))).toBe(false);
    });
  });
});
