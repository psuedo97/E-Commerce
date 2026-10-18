import { Prisma } from '@prisma/client';

export const orderInclude = {
  items: { orderBy: { id: 'asc' } },
  payments: { orderBy: { createdAt: 'desc' }, select: { status: true, provider: true, amount: true, createdAt: true } },
} satisfies Prisma.OrderInclude;

export type OrderWithDetails = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

/** The customer-facing shape of an order. Money in paise, GST-inclusive. */
export function toOrderView(o: OrderWithDetails) {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    fulfilment: o.fulfilment,
    paymentMethod: o.paymentMethod,
    items: o.items.map((i) => ({
      variantId: i.variantId, title: i.title, sku: i.sku, quantity: i.quantity,
      unitPrice: i.unitPrice, lineTotal: i.unitPrice * i.quantity, gstRate: i.gstRate,
    })),
    subtotal: o.subtotal,
    shippingFee: o.shippingFee,
    discount: o.discount,
    total: o.total,
    tax: o.tax,
    shippingAddress: o.shippingAddress,
    pickupLocationId: o.pickupLocationId,
    expiresAt: o.expiresAt,
    payment: o.payments[0] ?? null,
    createdAt: o.createdAt,
  };
}
