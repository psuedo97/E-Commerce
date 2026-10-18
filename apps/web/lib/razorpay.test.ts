import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCheckoutOptions, CHECKOUT_SCRIPT_URL, loadRazorpay, resetRazorpayLoader, type RazorpayConstructor } from './razorpay';
import type { PayInit } from './types';

const init: PayInit = {
  provider: 'razorpay', keyId: 'rzp_test_KEY', providerOrderId: 'order_ABC', amount: 64900, currency: 'INR',
  orderId: 'o1', orderNumber: 1042, expiresAt: null,
  prefill: { name: 'Asha Rawat', email: 'asha@example.com', contact: '9876543210' },
};

describe('buildCheckoutOptions', () => {
  const noop = { onSuccess: () => undefined, onDismiss: () => undefined };

  it('uses the server-provided key, order id and amount', () => {
    const o = buildCheckoutOptions(init, noop);
    expect(o).toMatchObject({
      key: 'rzp_test_KEY', order_id: 'order_ABC', amount: 64900, currency: 'INR', name: 'KOMA', description: 'Order #1042',
    });
  });

  it('prefills the customer’s details', () => {
    expect(buildCheckoutOptions(init, noop).prefill).toEqual({ name: 'Asha Rawat', email: 'asha@example.com', contact: '9876543210' });
  });

  it('leaves out details we do not have instead of passing blanks', () => {
    const o = buildCheckoutOptions({ ...init, prefill: { name: 'Asha', email: null, contact: null } }, noop);
    expect(o.prefill).toEqual({ name: 'Asha', email: undefined, contact: undefined });
  });

  it('wires the success and dismiss callbacks', () => {
    const onSuccess = vi.fn();
    const onDismiss = vi.fn();
    const o = buildCheckoutOptions(init, { onSuccess, onDismiss });
    const response = { razorpay_order_id: 'order_ABC', razorpay_payment_id: 'pay_1', razorpay_signature: 'sig' };
    o.handler(response);
    o.modal.ondismiss();
    expect(onSuccess).toHaveBeenCalledWith(response);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('loadRazorpay', () => {
  beforeEach(() => resetRazorpayLoader());

  const FakeRazorpay = class {} as unknown as RazorpayConstructor;

  /** A tiny stand-in for the browser: records appended scripts so the test can fire load/error. */
  function fakeEnv() {
    const scripts: Record<string, unknown>[] = [];
    const win: { Razorpay?: RazorpayConstructor } = {};
    return {
      win, scripts,
      env: {
        window: win,
        document: {
          createElement: () => ({}) as HTMLElement,
          getElementById: () => null,
          head: { appendChild: (s: unknown) => { scripts.push(s as Record<string, unknown>); return s as Node; } },
        },
      },
    };
  }

  it('adds the official script once and resolves when it has loaded', async () => {
    const { env, win, scripts } = fakeEnv();
    const promise = loadRazorpay(env as never);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({ src: CHECKOUT_SCRIPT_URL, async: true });
    win.Razorpay = FakeRazorpay;
    (scripts[0].onload as () => void)();
    await expect(promise).resolves.toBe(FakeRazorpay);
  });

  it('shares one script load between simultaneous callers', async () => {
    const { env, win, scripts } = fakeEnv();
    const [a, b] = [loadRazorpay(env as never), loadRazorpay(env as never)];
    expect(scripts).toHaveLength(1);
    win.Razorpay = FakeRazorpay;
    (scripts[0].onload as () => void)();
    await expect(Promise.all([a, b])).resolves.toEqual([FakeRazorpay, FakeRazorpay]);
  });

  it('resolves immediately when it is already on the page', async () => {
    const { env, win, scripts } = fakeEnv();
    win.Razorpay = FakeRazorpay;
    await expect(loadRazorpay(env as never)).resolves.toBe(FakeRazorpay);
    expect(scripts).toHaveLength(0);
  });

  it('reports a network failure and allows trying again', async () => {
    const { env, win, scripts } = fakeEnv();
    const first = loadRazorpay(env as never);
    (scripts[0].onerror as () => void)();
    await expect(first).rejects.toThrow(/Could not reach the payment provider/);

    const second = loadRazorpay(env as never); // a fresh attempt, not the cached failure
    expect(scripts).toHaveLength(2);
    win.Razorpay = FakeRazorpay;
    (scripts[1].onload as () => void)();
    await expect(second).resolves.toBe(FakeRazorpay);
  });

  it('reports a script that loaded but did not define Razorpay (e.g. blocked by an extension)', async () => {
    const { env, scripts } = fakeEnv();
    const p = loadRazorpay(env as never);
    (scripts[0].onload as () => void)();
    await expect(p).rejects.toThrow(/did not load/);
  });
});
