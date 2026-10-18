import { describe, expect, it } from 'vitest';
import { canCancel, minutesLeft, statusLabel } from './orders';
import type { OrderStatus } from './types';

describe('statusLabel', () => {
  it('uses customer-friendly wording', () => {
    expect(statusLabel('PENDING')).toBe('Awaiting payment');
    expect(statusLabel('READY_FOR_PICKUP')).toBe('Ready for pickup');
    expect(statusLabel('CANCELLED')).toBe('Cancelled');
  });

  it('covers every status', () => {
    const all: OrderStatus[] = ['PENDING', 'PAID', 'PACKED', 'SHIPPED', 'READY_FOR_PICKUP', 'DELIVERED', 'CANCELLED', 'REFUNDED'];
    for (const s of all) expect(statusLabel(s)).not.toBe(s);
  });

  it('falls back to the raw value for an unknown status', () => {
    expect(statusLabel('SOMETHING_NEW' as OrderStatus)).toBe('SOMETHING_NEW');
  });
});

describe('minutesLeft', () => {
  const now = Date.parse('2026-10-18T10:00:00Z');

  it('rounds up so "0 minutes" is never shown while time remains', () => {
    expect(minutesLeft('2026-10-18T10:29:30Z', now)).toBe(30);
    expect(minutesLeft('2026-10-18T10:00:01Z', now)).toBe(1);
    expect(minutesLeft('2026-10-18T10:30:00Z', now)).toBe(30);
  });

  it('is 0 once the deadline has passed, never negative', () => {
    expect(minutesLeft('2026-10-18T10:00:00Z', now)).toBe(0);
    expect(minutesLeft('2026-10-18T09:00:00Z', now)).toBe(0);
  });

  it('is null when there is no deadline', () => {
    expect(minutesLeft(null, now)).toBeNull();
  });
});

describe('canCancel', () => {
  it('allows only unpaid orders', () => {
    expect(canCancel('PENDING')).toBe(true);
    for (const s of ['PAID', 'PACKED', 'SHIPPED', 'READY_FOR_PICKUP', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const) {
      expect(canCancel(s)).toBe(false);
    }
  });
});
