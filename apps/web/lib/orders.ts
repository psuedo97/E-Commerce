import type { OrderStatus } from './types';

const LABELS: Record<OrderStatus, string> = {
  PENDING: 'Awaiting payment',
  PAID: 'Paid',
  PACKED: 'Packed',
  SHIPPED: 'Shipped',
  READY_FOR_PICKUP: 'Ready for pickup',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

export const statusLabel = (s: OrderStatus): string => LABELS[s] ?? s;

/** Whole minutes left until `expiresAt`, never negative. Null when there is no deadline. */
export function minutesLeft(expiresAt: string | null, now = Date.now()): number | null {
  if (!expiresAt) return null;
  return Math.max(Math.ceil((new Date(expiresAt).getTime() - now) / 60_000), 0);
}

/** Customers may cancel only orders that have not been paid yet. */
export const canCancel = (s: OrderStatus): boolean => s === 'PENDING';
