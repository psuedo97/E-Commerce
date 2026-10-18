import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, StockReservation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export interface ReserveItem {
  variantId: string;
  quantity: number;
}

export interface ReserveOptions {
  /** Only take stock from this location (store pickup). Default: any active location. */
  locationId?: string;
  /** How long the hold lasts before releaseExpired() frees it. Default 30. */
  ttlMinutes?: number;
  /** Run inside the caller's transaction (checkout creates the order and reserves atomically). */
  tx?: Tx;
}

export interface Shortage {
  variantId: string;
  requested: number;
  available: number;
}

/**
 * Holds stock for orders. `reserved` on StockLevel counts active holds; a hold never exceeds
 * what is on hand. Every operation is idempotent per reservation, so retries and webhook
 * re-deliveries cannot double-release or double-sell.
 */
@Injectable()
export class ReservationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * All-or-nothing: either every item is reserved or none is (and a 409 lists the shortages).
   * When no location is given, stock is taken from the location with the most available first,
   * splitting across locations if one is not enough.
   */
  reserve(orderId: string, items: ReserveItem[], opts: ReserveOptions = {}): Promise<StockReservation[]> {
    return this.inTx(opts.tx, async (tx) => {
      const wanted = new Map<string, number>();
      for (const i of items) wanted.set(i.variantId, (wanted.get(i.variantId) ?? 0) + i.quantity);

      const expiresAt = new Date(Date.now() + (opts.ttlMinutes ?? 30) * 60_000);
      const holds: Prisma.StockReservationCreateManyInput[] = [];
      const shortages: Shortage[] = [];

      // Fixed order avoids deadlocks between two orders reserving the same variants.
      for (const variantId of [...wanted.keys()].sort()) {
        const requested = wanted.get(variantId)!;
        let remaining = requested;

        // A few passes: if another request grabs stock between our read and update, re-read.
        for (let pass = 0; pass < 3 && remaining > 0; pass++) {
          const levels = await tx.stockLevel.findMany({
            where: { variantId, locationId: opts.locationId, location: { active: true } },
          });
          levels.sort((a, b) => b.onHand - b.reserved - (a.onHand - a.reserved));
          for (const level of levels) {
            const take = Math.min(remaining, level.onHand - level.reserved);
            if (take <= 0) continue;
            const claimed = await tx.$executeRaw`
              UPDATE "StockLevel" SET reserved = reserved + ${take}
              WHERE id = ${level.id} AND "onHand" - reserved >= ${take}`;
            if (claimed === 1) {
              holds.push({ orderId, variantId, locationId: level.locationId, quantity: take, expiresAt });
              remaining -= take;
              if (remaining === 0) break;
            }
          }
        }
        if (remaining > 0) shortages.push({ variantId, requested, available: requested - remaining });
      }

      if (shortages.length > 0) {
        // Throwing rolls back the holds taken above (they live in this transaction).
        throw new ConflictException({ message: 'Insufficient stock', shortages });
      }
      await tx.stockReservation.createMany({ data: holds });
      return tx.stockReservation.findMany({ where: { orderId, status: 'ACTIVE' }, orderBy: { id: 'asc' } });
    });
  }

  /** Frees an order's active holds (payment failed, cancelled, or expired). Returns units released. */
  release(orderId: string, tx?: Tx): Promise<number> {
    return this.inTx(tx, async (t) => {
      const holds = await t.stockReservation.findMany({ where: { orderId, status: 'ACTIVE' } });
      let units = 0;
      for (const h of holds) {
        // The status flip is the guard: only one caller can win it, so stock is freed exactly once.
        const won = await t.stockReservation.updateMany({
          where: { id: h.id, status: 'ACTIVE' }, data: { status: 'RELEASED' },
        });
        if (won.count === 0) continue;
        await t.$executeRaw`
          UPDATE "StockLevel" SET reserved = reserved - ${h.quantity}
          WHERE "variantId" = ${h.variantId} AND "locationId" = ${h.locationId}`;
        units += h.quantity;
      }
      return units;
    });
  }

  /**
   * Turns holds into a sale: on-hand and reserved both drop, and a SALE movement is logged.
   * Returns units committed; 0 means there was nothing active (already committed, or the hold
   * expired and was released, in which case the caller must reserve again).
   */
  commit(orderId: string, tx?: Tx): Promise<number> {
    return this.inTx(tx, async (t) => {
      const holds = await t.stockReservation.findMany({ where: { orderId, status: 'ACTIVE' } });
      let units = 0;
      for (const h of holds) {
        const won = await t.stockReservation.updateMany({
          where: { id: h.id, status: 'ACTIVE' }, data: { status: 'COMMITTED' },
        });
        if (won.count === 0) continue;
        const [row] = await t.$queryRaw<{ onHand: number }[]>`
          UPDATE "StockLevel" SET "onHand" = "onHand" - ${h.quantity}, reserved = reserved - ${h.quantity}
          WHERE "variantId" = ${h.variantId} AND "locationId" = ${h.locationId}
          RETURNING "onHand"`;
        await t.stockMovement.create({
          data: {
            variantId: h.variantId, locationId: h.locationId, type: 'SALE', quantity: -h.quantity,
            balanceAfter: row.onHand, orderId,
          },
        });
        units += h.quantity;
      }
      return units;
    });
  }

  /** Releases every hold past its expiry. Returns the affected order ids so the caller can cancel them. */
  async releaseExpired(now = new Date()): Promise<string[]> {
    const expired = await this.prisma.stockReservation.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: now } },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    const released: string[] = [];
    for (const { orderId } of expired) {
      if ((await this.release(orderId)) > 0) released.push(orderId);
    }
    return released;
  }

  private inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.prisma.$transaction(fn);
  }
}
