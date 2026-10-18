import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ProductStatus } from '@prisma/client';
import { MAX_LINE_QUANTITY } from '../orders/pricing';
import { PrismaService } from '../prisma/prisma.service';

/** Who is asking: a logged-in user, or a guest identified by the secret id of their cart. */
export interface CartActor {
  userId?: string;
  cartId?: string;
}

export type LineStatus = 'OK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNAVAILABLE';

const cartInclude = {
  items: {
    orderBy: { id: 'asc' },
    include: {
      variant: {
        include: {
          product: { include: { images: { orderBy: { position: 'asc' }, take: 1 } } },
          stock: { where: { location: { active: true } } },
        },
      },
    },
  },
} satisfies Prisma.CartInclude;

type CartWithItems = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  async get(actor: CartActor) {
    const cart = await this.find(actor);
    return this.view(cart);
  }

  async addItem(actor: CartActor, variantId: string, quantity: number) {
    const variant = await this.requireBuyable(variantId);
    const cart = await this.findOrCreate(actor);
    const existing = cart.items.find((i) => i.variantId === variantId)?.quantity ?? 0;
    this.checkQuantity(existing + quantity, this.availableOf(variant.stock));
    await this.prisma.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      create: { cartId: cart.id, variantId, quantity },
      update: { quantity: existing + quantity },
    });
    return this.view(await this.reload(cart.id));
  }

  async setQuantity(actor: CartActor, variantId: string, quantity: number) {
    const variant = await this.requireBuyable(variantId);
    const cart = await this.find(actor);
    if (!cart?.items.some((i) => i.variantId === variantId)) throw new NotFoundException('Item is not in your cart');
    this.checkQuantity(quantity, this.availableOf(variant.stock));
    await this.prisma.cartItem.update({ where: { cartId_variantId: { cartId: cart.id, variantId } }, data: { quantity } });
    return this.view(await this.reload(cart.id));
  }

  async removeItem(actor: CartActor, variantId: string) {
    const cart = await this.find(actor);
    if (!cart) throw new NotFoundException('Item is not in your cart');
    const removed = await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id, variantId } });
    if (removed.count === 0) throw new NotFoundException('Item is not in your cart');
    return this.view(await this.reload(cart.id));
  }

  async clear(actor: CartActor) {
    const cart = await this.find(actor);
    if (cart) await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    return this.view(cart ? await this.reload(cart.id) : null);
  }

  /** After login: moves a guest cart's items into the user's cart. Safe to call twice. */
  async merge(userId: string, guestCartId: string) {
    await this.prisma.$transaction(async (tx) => {
      const guest = await tx.cart.findFirst({ where: { id: guestCartId, userId: null }, include: { items: true } });
      if (!guest) return;
      const mine = await tx.cart.upsert({ where: { userId }, create: { userId }, update: {}, include: { items: true } });
      for (const item of guest.items) {
        const have = mine.items.find((i) => i.variantId === item.variantId)?.quantity ?? 0;
        // Capped per line only; stock problems show up as warnings in the cart.
        const quantity = Math.min(have + item.quantity, MAX_LINE_QUANTITY);
        await tx.cartItem.upsert({
          where: { cartId_variantId: { cartId: mine.id, variantId: item.variantId } },
          create: { cartId: mine.id, variantId: item.variantId, quantity },
          update: { quantity },
        });
      }
      await tx.cart.delete({ where: { id: guest.id } });
    });
    return this.get({ userId });
  }

  /** Housekeeping: guest carts nobody has touched for a while. */
  async purgeStaleGuestCarts(olderThanDays = 30, now = new Date()) {
    const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);
    const { count } = await this.prisma.cart.deleteMany({ where: { userId: null, updatedAt: { lt: cutoff } } });
    return count;
  }

  // ---------- helpers ----------

  private async find(actor: CartActor): Promise<CartWithItems | null> {
    if (actor.userId) return this.prisma.cart.findUnique({ where: { userId: actor.userId }, include: cartInclude });
    if (actor.cartId) return this.prisma.cart.findFirst({ where: { id: actor.cartId, userId: null }, include: cartInclude });
    return null;
  }

  private async findOrCreate(actor: CartActor): Promise<CartWithItems> {
    const found = await this.find(actor);
    if (found) return found;
    // A guest with an unknown or expired cart id simply gets a fresh cart (the client stores the new id).
    const created = actor.userId
      ? await this.prisma.cart.upsert({ where: { userId: actor.userId }, create: { userId: actor.userId }, update: {} })
      : await this.prisma.cart.create({ data: {} });
    return this.reload(created.id);
  }

  private async reload(id: string): Promise<CartWithItems> {
    // Touch updatedAt so active guest carts are not purged.
    await this.prisma.cart.update({ where: { id }, data: { updatedAt: new Date() } });
    return this.prisma.cart.findUniqueOrThrow({ where: { id }, include: cartInclude });
  }

  private async requireBuyable(variantId: string) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, product: { status: ProductStatus.ACTIVE } },
      include: { stock: { where: { location: { active: true } } } },
    });
    if (!variant) throw new NotFoundException('This product is not available');
    return variant;
  }

  private availableOf(stock: { onHand: number; reserved: number }[]) {
    return stock.reduce((n, s) => n + Math.max(s.onHand - s.reserved, 0), 0);
  }

  private checkQuantity(wanted: number, available: number) {
    if (wanted > MAX_LINE_QUANTITY) {
      throw new BadRequestException(`You can buy at most ${MAX_LINE_QUANTITY} of one item`);
    }
    if (wanted > available) {
      throw new ConflictException({
        message: available === 0 ? 'Out of stock' : `Only ${available} available`,
        available,
      });
    }
  }

  private view(cart: CartWithItems | null) {
    const items = (cart?.items ?? []).map((i) => {
      const v = i.variant;
      const available = this.availableOf(v.stock);
      const status: LineStatus =
        v.product.status !== 'ACTIVE' ? 'UNAVAILABLE'
        : available === 0 ? 'OUT_OF_STOCK'
        : i.quantity > available ? 'LOW_STOCK'
        : 'OK';
      return {
        variantId: v.id, sku: v.sku, productId: v.product.id, title: v.product.title, slug: v.product.slug,
        image: v.product.images[0]?.url ?? null, attributes: v.attributes,
        unitPrice: v.price, mrp: v.mrp, gstRate: v.product.gstRate,
        quantity: i.quantity, lineTotal: v.price * i.quantity,
        available: Math.min(available, MAX_LINE_QUANTITY), status,
      };
    });
    return {
      id: cart?.id ?? null,
      items,
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      subtotal: items.reduce((n, i) => n + i.lineTotal, 0),
      hasIssues: items.some((i) => i.status !== 'OK'),
    };
  }
}
