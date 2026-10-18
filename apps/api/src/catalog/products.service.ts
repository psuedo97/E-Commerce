import {
  BadRequestException, ConflictException, Injectable, NotFoundException, UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Prisma, ProductStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CategoriesService } from './categories.service';
import {
  AdminListProductsQuery, CreateProductDto, ListProductsQuery, UpdateProductDto, UpdateVariantDto, VariantDto,
} from './catalog.dto';
import { detectImageExt } from './image-type';
import { uniqueSlug } from './slug';

type Stock = { onHand: number; reserved: number }[];
const available = (stock: Stock) => stock.reduce((sum, s) => sum + Math.max(s.onHand - s.reserved, 0), 0);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly storage: StorageService,
  ) {}

  // ---------- public ----------

  async list(q: ListProductsQuery, status?: ProductStatus | 'ANY') {
    const page = q.page ?? 1;
    const limit = q.limit ?? 12;

    const where: Prisma.ProductWhereInput = {};
    if (status !== 'ANY') where.status = status ?? ProductStatus.ACTIVE;
    if (q.category) {
      const ids = await this.categories.idsWithDescendants(q.category);
      where.categoryId = { in: ids }; // unknown slug -> empty list
    }
    if (q.minPrice !== undefined || q.maxPrice !== undefined) {
      where.minPrice = { gte: q.minPrice, lte: q.maxPrice };
    }
    const term = q.search?.trim();
    if (term) {
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { brand: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ];
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      q.sort === 'price_asc' ? [{ minPrice: 'asc' }, { id: 'asc' }]
      : q.sort === 'price_desc' ? [{ minPrice: 'desc' }, { id: 'asc' }]
      : [{ createdAt: 'desc' }, { id: 'asc' }];

    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where, orderBy, skip: (page - 1) * limit, take: limit,
        select: {
          id: true, title: true, slug: true, brand: true, status: true, minPrice: true,
          images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
          variants: { orderBy: { price: 'asc' }, select: { mrp: true, price: true, stock: { where: { location: { active: true } }, select: { onHand: true, reserved: true } } } },
        },
      }),
    ]);

    return {
      items: rows.map((p) => ({
        id: p.id, title: p.title, slug: p.slug, brand: p.brand, status: p.status,
        price: p.minPrice,
        mrp: p.variants[0]?.mrp ?? p.minPrice,
        image: p.images[0]?.url ?? null,
        inStock: p.variants.some((v) => available(v.stock) > 0),
      })),
      page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1),
    };
  }

  async detail(slug: string) {
    const p = await this.prisma.product.findFirst({
      where: { slug, status: ProductStatus.ACTIVE },
      include: {
        category: { select: { name: true, slug: true } },
        images: { orderBy: { position: 'asc' }, select: { id: true, url: true } },
        variants: { orderBy: { price: 'asc' }, include: { stock: { where: { location: { active: true } }, select: { onHand: true, reserved: true } } } },
      },
    });
    if (!p) throw new NotFoundException('Product not found');
    return {
      id: p.id, title: p.title, slug: p.slug, description: p.description, brand: p.brand,
      gstRate: p.gstRate, category: p.category, images: p.images,
      variants: p.variants.map((v) => {
        const qty = available(v.stock);
        // Exact counts are not exposed publicly; only a "low stock" hint.
        return { id: v.id, sku: v.sku, mrp: v.mrp, price: v.price, attributes: v.attributes, inStock: qty > 0, lowStock: qty > 0 && qty <= 5 };
      }),
    };
  }

  // ---------- admin ----------

  adminList(q: AdminListProductsQuery) {
    return this.list(q, q.status ?? 'ANY');
  }

  async adminDetail(id: string) {
    const p = await this.prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        images: { orderBy: { position: 'asc' } },
        variants: { include: { stock: true } },
      },
    });
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }

  async create(dto: CreateProductDto) {
    const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId } });
    if (!category) throw new BadRequestException('Unknown categoryId');
    dto.variants.forEach((v) => this.checkPrice(v.price, v.mrp));
    this.checkDistinctSkus(dto.variants);

    const slug = await uniqueSlug(dto.title, async (s) => !!(await this.prisma.product.findUnique({ where: { slug: s } })));
    try {
      return await this.prisma.product.create({
        data: {
          title: dto.title.trim(), slug, description: dto.description, brand: dto.brand,
          hsnCode: dto.hsnCode, gstRate: dto.gstRate ?? 18, status: dto.status ?? ProductStatus.DRAFT,
          categoryId: dto.categoryId,
          minPrice: Math.min(...dto.variants.map((v) => v.price)),
          variants: { create: dto.variants.map((v) => ({ ...v, attributes: v.attributes as Prisma.InputJsonObject })) },
        },
        include: { variants: true },
      });
    } catch (e) {
      throw this.mapUniqueError(e);
    }
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.requireProduct(id);
    if (dto.categoryId) {
      const category = await this.prisma.category.findUnique({ where: { id: dto.categoryId } });
      if (!category) throw new BadRequestException('Unknown categoryId');
    }
    const { title, ...rest } = dto;
    return this.prisma.product.update({ where: { id }, data: { ...rest, title: title?.trim() } });
  }

  /** Products are archived, not deleted, so past orders keep their references. */
  async archive(id: string) {
    await this.requireProduct(id);
    await this.prisma.product.update({ where: { id }, data: { status: ProductStatus.ARCHIVED } });
  }

  async addVariant(productId: string, dto: VariantDto) {
    await this.requireProduct(productId);
    this.checkPrice(dto.price, dto.mrp);
    try {
      const variant = await this.prisma.productVariant.create({
        data: { ...dto, attributes: dto.attributes as Prisma.InputJsonObject, productId },
      });
      await this.syncMinPrice(productId);
      return variant;
    } catch (e) {
      throw this.mapUniqueError(e);
    }
  }

  async updateVariant(id: string, dto: UpdateVariantDto) {
    const variant = await this.prisma.productVariant.findUnique({ where: { id } });
    if (!variant) throw new NotFoundException('Variant not found');
    this.checkPrice(dto.price ?? variant.price, dto.mrp ?? variant.mrp);
    try {
      const updated = await this.prisma.productVariant.update({
        where: { id },
        data: { ...dto, attributes: dto.attributes as Prisma.InputJsonObject | undefined },
      });
      await this.syncMinPrice(variant.productId);
      return updated;
    } catch (e) {
      throw this.mapUniqueError(e);
    }
  }

  async removeVariant(id: string) {
    const variant = await this.prisma.productVariant.findUnique({ where: { id } });
    if (!variant) throw new NotFoundException('Variant not found');
    const siblings = await this.prisma.productVariant.count({ where: { productId: variant.productId } });
    if (siblings <= 1) throw new BadRequestException('A product needs at least one variant; archive it instead');
    try {
      await this.prisma.productVariant.delete({ where: { id } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new ConflictException('Variant is part of existing orders and cannot be deleted');
      }
      throw e;
    }
    await this.syncMinPrice(variant.productId);
  }

  async addImage(productId: string, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Attach an image in the "file" field');
    await this.requireProduct(productId);
    if (file.size > MAX_IMAGE_BYTES) throw new BadRequestException('Image must be 5 MB or smaller');
    const ext = detectImageExt(file.buffer);
    if (!ext) throw new UnsupportedMediaTypeException('Only JPEG, PNG or WebP images are allowed');

    const url = await this.storage.save(`products/${productId}`, file.buffer, ext);
    const last = await this.prisma.productImage.aggregate({ where: { productId }, _max: { position: true } });
    return this.prisma.productImage.create({
      data: { productId, url, position: (last._max.position ?? -1) + 1 },
    });
  }

  async removeImage(id: string) {
    const image = await this.prisma.productImage.findUnique({ where: { id } });
    if (!image) throw new NotFoundException('Image not found');
    await this.prisma.productImage.delete({ where: { id } });
    await this.storage.remove(image.url);
  }

  // ---------- helpers ----------

  private async syncMinPrice(productId: string) {
    const agg = await this.prisma.productVariant.aggregate({ where: { productId }, _min: { price: true } });
    await this.prisma.product.update({ where: { id: productId }, data: { minPrice: agg._min.price ?? 0 } });
  }

  private async requireProduct(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private checkPrice(price: number, mrp: number) {
    if (price > mrp) throw new BadRequestException('price cannot be higher than mrp');
  }

  private checkDistinctSkus(variants: VariantDto[]) {
    const skus = variants.map((v) => v.sku);
    if (new Set(skus).size !== skus.length) throw new BadRequestException('Variant SKUs must be unique');
  }

  private mapUniqueError(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return new ConflictException('SKU or barcode already exists');
    }
    return e;
  }
}
