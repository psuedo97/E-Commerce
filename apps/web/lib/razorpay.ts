// Thin wrapper around Razorpay's hosted checkout window (https://checkout.razorpay.com/v1/checkout.js).
import type { PayInit } from './types';

export const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

/** What the payment window hands back after a successful payment. Forwarded to the API for verification. */
export interface RazorpaySuccess {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface RazorpayFailure {
  error?: { description?: string; reason?: string };
}

export interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill: { name?: string; email?: string; contact?: string };
  theme: { color: string };
  handler: (response: RazorpaySuccess) => void;
  modal: { ondismiss: () => void };
}

export interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (response: RazorpayFailure) => void): void;
}
export type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;

/** Turns the API's response into the options the payment window expects. The amount always comes from the server. */
export function buildCheckoutOptions(
  init: PayInit,
  callbacks: { onSuccess: (r: RazorpaySuccess) => void; onDismiss: () => void },
): RazorpayOptions {
  return {
    key: init.keyId,
    amount: init.amount,
    currency: init.currency,
    name: 'KOMA',
    description: `Order #${init.orderNumber}`,
    order_id: init.providerOrderId,
    // Only pass what we have: empty prefill values make the window show blank, uneditable fields.
    prefill: {
      name: init.prefill.name || undefined,
      email: init.prefill.email || undefined,
      contact: init.prefill.contact || undefined,
    },
    theme: { color: '#1f3d36' },
    handler: callbacks.onSuccess,
    modal: { ondismiss: callbacks.onDismiss },
  };
}

interface Env {
  document: Pick<Document, 'createElement' | 'getElementById'> & { head: Pick<HTMLElement, 'appendChild'> };
  window: { Razorpay?: RazorpayConstructor };
}

let pending: Promise<RazorpayConstructor> | null = null;

/** Loads Razorpay's script once and resolves with its constructor. Safe to call repeatedly. */
export function loadRazorpay(env?: Env): Promise<RazorpayConstructor> {
  const e = env ?? ({ document, window } as unknown as Env);
  if (e.window.Razorpay) return Promise.resolve(e.window.Razorpay);
  if (pending) return pending;

  pending = new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = e.document.createElement('script') as HTMLScriptElement;
    script.id = 'razorpay-checkout-js';
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (e.window.Razorpay) resolve(e.window.Razorpay);
      else { pending = null; reject(new Error('The payment window did not load. Please try again.')); }
    };
    script.onerror = () => {
      pending = null; // allow a retry after a network failure
      reject(new Error('Could not reach the payment provider. Check your connection and try again.'));
    };
    e.document.head.appendChild(script);
  });
  return pending;
}

/** For tests: forget a cached load. */
export function resetRazorpayLoader() {
  pending = null;
}
