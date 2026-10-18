import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AdjustReason, Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdjustDto, CountDto, ListInventoryQuery, MovementsQuery, ReceiveDto, TransferDto, VariantRefDto,
} from './inventory.dto';

type Tx = Prisma.TransactionClient;

type Movement = {
  variantId: string; locationId: string; type: StockMovementType; quantity: number; balanceAfter: number;
  reason?: AdjustReason; note?: string; userId?: string; orderId?: string;
};

/**
 * Stock changes use single atomic UPDATE statements (not read-then-write), so concurrent requests
 * cannot oversell. A CHECK constraint on StockLevel backs this up at the database level.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- reads ----------

  async list(q: ListInventoryQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;

    const where: Prisma.ProductVariantWhereInput = {};
    const term = q.search?.trim();
    if (term) {
      where.OR = [
        { sku: { contains: term, mode: 'insensitive' } },
        { barcode: { contains: term, mode: 'insensitive' } },
        { product: { title: { contains: term, mode: 'insensitive' } } },
      ];
    }
    if (q.locationId) where.stock = { some: { locationId: q.locationId } };
    if (q.lowStock !== undefined) {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT v.id FROM "ProductVariant" v
        LEFT JOIN "StockLevel" s ON s."variantId" = v.id
        LEFT JOIN "Location" l ON l.id = s."locationId" AND l.active
        GROUP BY v.id
        HAVING COALESCE(SUM(CASE WHEN l.id IS NOT NULL THEN s."onHand" - s.reserved ELSE 0 END), 0) <= ${q.lowStock}`;
      where.id = { in: rows.map((r) => r.id) };
    }

    const [total, variants] = await Promise.all([
      this.prisma.productVariant.count({ where }),
      this.prisma.productVariant.findMany({
        where,
        orderBy: [{ product: { title: 'asc' } }, { sku: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: this.variantInclude(q.locationId),
      }),
    ]);
    return { items: variants.map((v) => this.toItem(v)), page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) };
  }

  /** Look a variant up by scanned barcode or typed SKU. */
  async byCode(code: string) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { OR: [{ barcode: code }, { sku: code }] },
      include: this.variantInclude(),
    });
    if (!variant) throw new NotFoundException('No product with this barcode or SKU');
    return this.toItem(variant);
  }

  async movements(q: MovementsQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where: Prisma.StockMovementWhereInput = {
      variantId: q.variantId, locationId: q.locationId, type: q.type,
    };
    const [total, items] = await Promise.all([
      this.prisma.stockMovement.count({ where }),
      this.prisma.stockMovement.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        include: { variant: { select: { sku: true } }, location: { select: { name: true } } },
      }),
    ]);
    return { items, page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) };
  }

  // ---------- writes ----------

  async receive(userId: string, dto: ReceiveDto) {
    const variantId = await this.resolveVariantId(dto);
    await this.requireLocation(dto.locationId, { mustBeActive: true });
    return this.prisma.$transaction(async (tx) => {
      const balance = await this.increase(tx, variantId, dto.locationId, dto.quantity);
      await this.record(tx, {
        variantId, locationId: dto.locationId, type: 'RECEIVE', quantity: dto.quantity,
        balanceAfter: balance, note: dto.note, userId,
      });
      return this.levelSummary(tx, variantId, dto.locationId);
    });
  }

  async adjust(userId: string, dto: AdjustDto) {
    const variantId = await this.resolveVariantId(dto);
    await this.requireLocation(dto.locationId);
    return this.prisma.$transaction(async (tx) => {
      const balance =
        dto.delta > 0
          ? await this.increase(tx, variantId, dto.locationId, dto.delta)
          : await this.decrease(tx, variantId, dto.locationId, -dto.delta);
      await this.record(tx, {
        variantId, locationId: dto.locationId, type: 'ADJUSTMENT', quantity: dto.delta,
        balanceAfter: balance, reason: dto.reason, note: dto.note, userId,
      });
      return this.levelSummary(tx, variantId, dto.locationId);
    });
  }

  /** Stocktake: set on-hand to the physically counted number and log the difference. */
  async count(userId: string, dto: CountDto) {
    const variantId = await this.resolveVariantId(dto);
    await this.requireLocation(dto.locationId);
    return this.prisma.$transaction(async (tx) => {
      await tx.stockLevel.upsert({
        where: { variantId_locationId: { variantId, locationId: dto.locationId } },
        create: { variantId, locationId: dto.locationId, onHand: 0 },
        update: {},
      });
      // Lock the row so the delta we log is exact even with concurrent changes.
      const [row] = await tx.$queryRaw<{ onHand: number; reserved: number }[]>`
        SELECT "onHand", reserved FROM "StockLevel"
        WHERE "variantId" = ${variantId} AND "locationId" = ${dto.locationId} FOR UPDATE`;
      if (dto.counted < row.reserved) {
        throw new ConflictException(
          `Counted ${dto.counted}, but ${row.reserved} units are reserved for orders. Resolve those orders first.`,
        );
      }
      const delta = dto.counted - row.onHand;
      if (delta !== 0) {
        await tx.stockLevel.update({
          where: { variantId_locationId: { variantId, locationId: dto.locationId } },
          data: { onHand: dto.counted },
        });
        await this.record(tx, {
          variantId, locationId: dto.locationId, type: 'COUNT', quantity: delta,
          balanceAfter: dto.counted, note: dto.note, userId,
        });
      }
      return this.levelSummary(tx, variantId, dto.locationId);
    });
  }

  async transfer(userId: string, dto: TransferDto) {
    if (dto.fromLocationId === dto.toLocationId) throw new BadRequestException('Source and destination must differ');
    const variantId = await this.resolveVariantId(dto);
    await this.requireLocation(dto.fromLocationId);
    await this.requireLocation(dto.toLocationId, { mustBeActive: true });
    return this.prisma.$transaction(async (tx) => {
      const fromBalance = await this.decrease(tx, variantId, dto.fromLocationId, dto.quantity);
      const toBalance = await this.increase(tx, variantId, dto.toLocationId, dto.quantity);
      await this.record(tx, {
        variantId, locationId: dto.fromLocationId, type: 'TRANSFER_OUT', quantity: -dto.quantity,
        balanceAfter: fromBalance, note: dto.note, userId,
      });
      await this.record(tx, {
        variantId, locationId: dto.toLocationId, type: 'TRANSFER_IN', quantity: dto.quantity,
        balanceAfter: toBalance, note: dto.note, userId,
      });
      return {
        from: await this.levelSummary(tx, variantId, dto.fromLocationId),
        to: await this.levelSummary(tx, variantId, dto.toLocationId),
      };
    });
  }

  // ---------- helpers ----------

  private async increase(tx: Tx, variantId: string, locationId: string, qty: number): Promise<number> {
    const level = await tx.stockLevel.upsert({
      where: { variantId_locationId: { variantId, locationId } },
      create: { variantId, locationId, onHand: qty },
      update: { onHand: { increment: qty } },
    });
    return level.onHand;
  }

  /** Removes stock only if what remains still covers reservations; returns the new on-hand. */
  private async decrease(tx: Tx, variantId: string, locationId: string, qty: number): Promise<number> {
    const rows = await tx.$queryRaw<{ onHand: number }[]>`
      UPDATE "StockLevel" SET "onHand" = "onHand" - ${qty}
      WHERE "variantId" = ${variantId} AND "locationId" = ${locationId} AND "onHand" - ${qty} >= reserved
      RETURNING "onHand"`;
    if (rows.length === 0) {
      const level = await tx.stockLevel.findUnique({ where: { variantId_locationId: { variantId, locationId } } });
      const available = level ? level.onHand - level.reserved : 0;
      throw new ConflictException(
        `Cannot remove ${qty}: only ${available} available at this location` +
          (level?.reserved ? ` (${level.reserved} reserved for orders)` : ''),
      );
    }
    return rows[0].onHand;
  }

  private record(tx: Tx, m: Movement) {
    return tx.stockMovement.create({ data: m });
  }

  private async levelSummary(tx: Tx, variantId: string, locationId: string) {
    const l = await tx.stockLevel.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } });
    return { variantId, locationId, onHand: l.onHand, reserved: l.reserved, available: l.onHand - l.reserved };
  }

  private async resolveVariantId(ref: VariantRefDto): Promise<string> {
    if (!ref.variantId && !ref.code) throw new BadRequestException('Provide variantId or code (barcode / SKU)');
    const variant = await this.prisma.productVariant.findFirst({
      where: ref.variantId ? { id: ref.variantId } : { OR: [{ barcode: ref.code }, { sku: ref.code }] },
      select: { id: true },
    });
    if (!variant) throw new NotFoundException('Variant not found');
    return variant.id;
  }

  private async requireLocation(id: string, opts: { mustBeActive?: boolean } = {}) {
    const location = await this.prisma.location.findUnique({ where: { id } });
    if (!location) throw new NotFoundException('Location not found');
    if (opts.mustBeActive && !location.active) throw new ConflictException(`Location "${location.name}" is inactive`);
    return location;
  }

  private variantInclude(locationId?: string) {
    return {
      product: { select: { id: true, title: true, slug: true, status: true } },
      stock: { where: locationId ? { locationId } : undefined, include: { location: { select: { id: true, name: true, active: true } } } },
    } satisfies Prisma.ProductVariantInclude;
  }

  private toItem(v: Prisma.ProductVariantGetPayload<{ include: ReturnType<InventoryService['variantInclude']> }>) {
    const locations = v.stock.map((s) => ({
      locationId: s.locationId, name: s.location.name, active: s.location.active,
      onHand: s.onHand, reserved: s.reserved, available: s.onHand - s.reserved,
    }));
    // Totals only count active locations, matching what the storefront can sell.
    const active = locations.filter((l) => l.active);
    return {
      variantId: v.id, sku: v.sku, barcode: v.barcode, attributes: v.attributes, product: v.product,
      onHand: active.reduce((n, l) => n + l.onHand, 0),
      reserved: active.reduce((n, l) => n + l.reserved, 0),
      available: active.reduce((n, l) => n + l.available, 0),
      locations,
    };
  }
}
