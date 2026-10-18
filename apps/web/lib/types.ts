// Shapes returned by the API. Money is in paise (1 rupee = 100 paise) and includes GST.

export type User = { id: string; name: string; email: string; phone: string | null; role: 'CUSTOMER' | 'STAFF' | 'ADMIN' };

export type LineStatus = 'OK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';

export type CartLine = {
  variantId: string; sku: string; productId: string; title: string; slug: string; image: string | null;
  attributes: Record<string, string>; unitPrice: number; mrp: number; gstRate: number;
  quantity: number; lineTotal: number; available: number; status: LineStatus;
};

export type Cart = { id: string | null; items: CartLine[]; itemCount: number; subtotal: number; hasIssues: boolean };

export type Address = {
  id: string; name: string; phone: string; line1: string; line2: string | null;
  city: string; state: string; pincode: string; isDefault: boolean;
};

export type Store = { id: string; name: string; address: string; pincode: string };

export type Tax = {
  placeOfSupply: string; sellerState: string; intraState: boolean;
  taxableValue: number; cgst: number; sgst: number; igst: number; totalTax: number;
};

export type OrderItem = {
  variantId: string; title: string; sku: string; quantity: number; unitPrice: number; lineTotal: number; gstRate: number;
};

export type OrderStatus = 'PENDING' | 'PAID' | 'PACKED' | 'SHIPPED' | 'READY_FOR_PICKUP' | 'DELIVERED' | 'CANCELLED' | 'REFUNDED';

export type Order = {
  id: string; number: number; status: OrderStatus; fulfilment: 'SHIP' | 'STORE_PICKUP'; paymentMethod: 'ONLINE' | 'COD';
  items: OrderItem[]; subtotal: number; shippingFee: number; discount: number; total: number; tax: Tax;
  shippingAddress: Record<string, string | null>; pickupLocationId: string | null;
  expiresAt: string | null; payment: { status: string } | null; createdAt: string;
};

export type Paged<T> = { items: T[]; page: number; limit: number; total: number; totalPages: number };

export type Quote = {
  fulfilment: 'SHIP' | 'STORE_PICKUP'; items: OrderItem[]; subtotal: number; shippingFee: number; total: number; tax: Tax;
  stockIssues: { variantId: string; title: string; requested: number; available: number }[];
};

export type CheckoutRequest =
  | { fulfilment: 'SHIP'; addressId: string }
  | { fulfilment: 'STORE_PICKUP'; pickupLocationId: string; contactPhone?: string };

/** What POST /orders/:id/pay returns: everything needed to open the payment window. */
export type PayInit = {
  provider: 'razorpay' | 'mock';
  keyId: string;
  providerOrderId: string;
  amount: number; // paise
  currency: 'INR';
  orderId: string;
  orderNumber: number;
  expiresAt: string | null;
  prefill: { name: string; email: string | null; contact: string | null };
};

/** paid: confirmed now. already_paid: confirmed earlier. refund_queued: items sold out meanwhile, money goes back. */
export type PaymentOutcome = 'paid' | 'already_paid' | 'refund_queued' | 'ignored' | 'failed';

export type PaymentResult = { outcome: PaymentOutcome; order: Order };
