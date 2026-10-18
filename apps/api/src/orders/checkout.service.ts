import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReservationService, Shortage } from '../inventory/reservation.service';
import { PrismaService } from '../prisma/prisma.service';
import { ServiceabilityService } from '../shipping/serviceability.service';
import { orderInclude, toOrderView } from './order-view';
import { CheckoutDto } from './orders.dto';
import { computeTotals } from './pricing';

type Tx = Prisma.TransactionClient;

/** Unpaid orders keep their stock for this long. */
const holdMinutes = () => Number(process.env.ORDER_HOLD_MINUTES ?? 30);
/** Stops one account from locking up stock with a pile of unpaid orders. */
const MAX_PENDING_ORDERS = 3;

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationService,
    private readonly serviceability: ServiceabilityService,
  ) {}

  /** What the order would cost, without creating anything or holding stock. */
  async quote(userId: string, dto: CheckoutDto) {
    const draft = await this.buildDraft(this.prisma, userId, dto);
    const stockIssues = await this.stockIssues(draft.lines, draft.pickupLocationId);
    return {
      fulfilment: dto.fulfilment,
      items: draft.lines.map(({ variantId, title, sku, quantity, unitPrice, gstRate }) => ({
        variantId, title, sku, quantity, unitPrice, gstRate, lineTotal: unitPrice * quantity,
      })),
      subtotal: draft.totals.subtotal,
      shippingFee: draft.totals.shippingFee,
      total: draft.totals.total,
      tax: draft.totals.tax,
      stockIssues,
    };
  }

  /** Creates the order from the cart, holds the stock and empties the cart: all in one transaction. */
  async placeOrder(userId: string, dto: CheckoutDto) {
    return this.prisma.$transaction(async (tx) => {
      // Serialises double-clicks and parallel tabs: the second request waits here, then finds an empty cart.
      await tx.$queryRaw`SELECT id FROM "Cart" WHERE "userId" = ${userId} FOR UPDATE`;

      const pending = await tx.order.count({ where: { userId, status: 'PENDING' } });
      if (pending >= MAX_PENDING_ORDERS) {
        throw new ConflictException('You have unpaid orders waiting. Please pay for or cancel one before placing another.');
      }

      const draft = await this.buildDraft(tx, userId, dto);
      const { totals } = draft;

      const order = await tx.order.create({
        data: {
          userId,
          channel: 'ONLINE',
          fulfilment: dto.fulfilment,
          pickupLocationId: draft.pickupLocationId,
          status: 'PENDING',
          paymentMethod: 'ONLINE',
          subtotal: totals.subtotal,
          shippingFee: totals.shippingFee,
          total: totals.total,
          shippingAddress: draft.snapshot,
          tax: { ...totals.tax },
          items: {
            create: draft.lines.map((l) => ({
              variantId: l.variantId, title: l.title, sku: l.sku, hsnCode: l.hsnCode,
              gstRate: l.gstRate, unitPrice: l.unitPrice, quantity: l.quantity,
            })),
          },
        },
      });

      let holds;
      try {
        holds = await this.reservations.reserve(
          order.id,
          draft.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
          { tx, locationId: draft.pickupLocationId, ttlMinutes: holdMinutes() },
        );
      } catch (e) {
        throw this.describeShortage(e, draft.lines);
      }

      await tx.order.update({ where: { id: order.id }, data: { expiresAt: holds[0].expiresAt } });
      await tx.cartItem.deleteMany({ where: { cartId: draft.cartId } });

      const full = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      return toOrderView(full);
    });
  }

  // ---------- internals ----------

  /** Reads the cart and address from the database and prices everything. Shared by quote and placeOrder. */
  private async buildDraft(db: Tx, userId: string, dto: CheckoutDto) {
    if (dto.paymentMethod === 'COD') {
      throw new BadRequestException('Cash on delivery is not available. Please pay online.');
    }

    const cart = await db.cart.findUnique({
      where: { userId },
      include: { items: { orderBy: { id: 'asc' }, include: { variant: { include: { product: true } } } } },
    });
    if (!cart || cart.items.length === 0) throw new BadRequestException('Your cart is empty');

    const gone = cart.items.filter((i) => i.variant.product.status !== 'ACTIVE');
    if (gone.length > 0) {
      throw new ConflictException({
        message: 'Some items are no longer available. Remove them from your cart to continue.',
        items: gone.map((i) => ({ variantId: i.variantId, title: i.variant.product.title })),
      });
    }

    let snapshot: Prisma.InputJsonObject;
    let pickupLocationId: string | undefined;
    let deliveryState: string | undefined;

    if (dto.fulfilment === 'SHIP') {
      const address = await db.address.findFirst({ where: { id: dto.addressId, userId } });
      if (!address) throw new NotFoundException('Delivery address not found');
      const { serviceable } = await this.serviceability.check(address.pincode);
      if (!serviceable) throw new BadRequestException(`Sorry, we do not deliver to pincode ${address.pincode} yet.`);
      deliveryState = address.state;
      snapshot = {
        type: 'SHIP', name: address.name, phone: address.phone, line1: address.line1, line2: address.line2,
        city: address.city, state: address.state, pincode: address.pincode,
      };
    } else {
      const location = await db.location.findFirst({ where: { id: dto.pickupLocationId, active: true, isStore: true } });
      if (!location) throw new NotFoundException('Pickup location not found');
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      const contactPhone = dto.contactPhone ?? user.phone;
      if (!contactPhone) throw new BadRequestException('A contact phone number is required for store pickup');
      pickupLocationId = location.id;
      snapshot = {
        type: 'PICKUP', contactName: user.name, contactPhone, locationId: location.id,
        locationName: location.name, address: location.address, pincode: location.pincode,
      };
    }

    const lines = cart.items.map((i) => {
      const attrs = Object.values((i.variant.attributes ?? {}) as Record<string, string>).join(' / ');
      return {
        variantId: i.variantId,
        title: attrs ? `${i.variant.product.title} (${attrs})` : i.variant.product.title,
        sku: i.variant.sku,
        hsnCode: i.variant.product.hsnCode,
        gstRate: i.variant.product.gstRate,
        unitPrice: i.variant.price, // always the current database price, never a client-supplied one
        quantity: i.quantity,
      };
    });

    return {
      cartId: cart.id, lines, snapshot, pickupLocationId,
      totals: computeTotals(lines, dto.fulfilment, deliveryState),
    };
  }

  private async stockIssues(lines: { variantId: string; title: string; quantity: number }[], locationId?: string) {
    const levels = await this.prisma.stockLevel.findMany({
      where: { variantId: { in: lines.map((l) => l.variantId) }, locationId, location: { active: true } },
    });
    return lines
      .map((l) => ({
        variantId: l.variantId, title: l.title, requested: l.quantity,
        available: levels.filter((s) => s.variantId === l.variantId).reduce((n, s) => n + Math.max(s.onHand - s.reserved, 0), 0),
      }))
      .filter((l) => l.available < l.requested);
  }

  /** Turns the reservation service's shortage list (variant ids) into something a customer can read. */
  private describeShortage(e: unknown, lines: { variantId: string; title: string; sku: string }[]) {
    if (!(e instanceof ConflictException)) return e;
    const body = e.getResponse() as { shortages?: Shortage[] };
    if (!body.shortages) return e;
    return new ConflictException({
      message: 'Some items are no longer available in the quantity you asked for.',
      items: body.shortages.map((s) => {
        const line = lines.find((l) => l.variantId === s.variantId);
        return { variantId: s.variantId, title: line?.title, sku: line?.sku, requested: s.requested, available: s.available };
      }),
    });
  }
}
