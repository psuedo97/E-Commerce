'use client';

import { useState } from 'react';
import { client } from '../lib/client';
import { formatINR } from '../lib/format';
import { buildCheckoutOptions, loadRazorpay, type RazorpaySuccess } from '../lib/razorpay';
import type { Order, PayInit, PaymentResult } from '../lib/types';

type Note = { kind: 'ok' | 'error' | 'info'; text: string };

const CONFIRM_TROUBLE =
  'We could not confirm your payment yet. If money was deducted, your order will update on its own within a minute or two. Refresh this page to check.';

/** The "Pay now" box on an unpaid order. Opens Razorpay, or shows test buttons when the server is in test mode. */
export default function PayPanel({ order, onOrderChange }: { order: Order; onOrderChange: (o: Order) => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [testInit, setTestInit] = useState<PayInit | null>(null);

  // Once paid, refunded or cancelled this panel disappears, so the order page itself explains those
  // outcomes (they must still be visible after a reload). Here we only say what helps a retry.
  function applyResult(result: PaymentResult) {
    onOrderChange(result.order);
    setTestInit(null);
    setNote(result.outcome === 'failed' ? { kind: 'error', text: 'The payment did not go through. You can try again.' } : null);
  }

  async function confirm(response: RazorpaySuccess) {
    setBusy(true);
    try {
      applyResult(await client.post<PaymentResult>('/payments/verify', response));
    } catch {
      setNote({ kind: 'error', text: CONFIRM_TROUBLE });
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setNote(null);
    try {
      const init = await client.post<PayInit>(`/orders/${order.id}/pay`);
      if (init.provider === 'mock') {
        setTestInit(init);
        return;
      }
      const Razorpay = await loadRazorpay();
      const window = new Razorpay(
        buildCheckoutOptions(init, {
          onSuccess: (r) => void confirm(r),
          onDismiss: () => setNote({ kind: 'info', text: 'The payment window was closed. You can try again whenever you are ready.' }),
        }),
      );
      window.on('payment.failed', (r) =>
        setNote({ kind: 'error', text: r.error?.description ?? 'The payment failed. Please try again.' }),
      );
      window.open();
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Could not start the payment.' });
    } finally {
      setBusy(false);
    }
  }

  async function simulate(outcome: 'success' | 'failure') {
    setBusy(true);
    try {
      applyResult(await client.post<PaymentResult>('/payments/simulate', { orderId: order.id, outcome }));
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Simulation failed.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pay-panel">
      {order.payment?.status === 'FAILED' && !note && (
        <p className="error-text">Your last payment attempt did not go through. You can try again.</p>
      )}

      {testInit ? (
        <div className="test-mode" data-testid="test-mode">
          <strong>Test mode</strong>
          <p className="muted small">
            No real payment provider is connected, so no money moves. Choose what should happen to this {formatINR(testInit.amount)} payment.
          </p>
          <button className="btn block" disabled={busy} onClick={() => simulate('success')}>Simulate successful payment</button>
          <button className="btn secondary block" disabled={busy} onClick={() => simulate('failure')}>Simulate failed payment</button>
        </div>
      ) : (
        <button className="btn block" disabled={busy} onClick={start}>
          {busy ? 'Please wait...' : `Pay ${formatINR(order.total)}`}
        </button>
      )}

      {note && (
        <p className={note.kind === 'ok' ? 'ok-text' : note.kind === 'error' ? 'error-text' : 'muted'} role="status">
          {note.text}
        </p>
      )}
      <p className="muted small">Secure payment by Razorpay: UPI, cards and net banking.</p>
    </div>
  );
}
