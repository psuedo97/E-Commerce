import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Category } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './catalog.dto';
import { uniqueSlug } from './slug';

export type CategoryNode = Category & { children: CategoryNode[] };

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async tree(): Promise<CategoryNode[]> {
    const all = await this.prisma.category.findMany({ orderBy: { name: 'asc' } });
    const nodes = new Map<string, CategoryNode>(all.map((c) => [c.id, { ...c, children: [] }]));
    const roots: CategoryNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  /** Category id plus the ids of all its descendants, looked up by slug. */
  async idsWithDescendants(slug: string): Promise<string[]> {
    const all = await this.prisma.category.findMany({ select: { id: true, slug: true, parentId: true } });
    const root = all.find((c) => c.slug === slug);
    if (!root) return [];
    const ids = [root.id];
    for (let i = 0; i < ids.length; i++) {
      for (const c of all) if (c.parentId === ids[i]) ids.push(c.id);
    }
    return ids;
  }

  async create(dto: CreateCategoryDto) {
    if (dto.parentId) await this.requireCategory(dto.parentId);
    const slug = await uniqueSlug(dto.name, async (s) => !!(await this.prisma.category.findUnique({ where: { slug: s } })));
    return this.prisma.category.create({ data: { name: dto.name.trim(), slug, parentId: dto.parentId } });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    await this.requireCategory(id);
    if (dto.parentId) {
      await this.requireCategory(dto.parentId);
      // A category cannot be moved under itself or one of its own descendants.
      const all = await this.prisma.category.findMany({ select: { id: true, parentId: true } });
      for (let cur: string | null | undefined = dto.parentId; cur; cur = all.find((c) => c.id === cur)?.parentId) {
        if (cur === id) throw new BadRequestException('A category cannot be its own ancestor');
      }
    }
    return this.prisma.category.update({
      where: { id },
      data: { name: dto.name?.trim(), parentId: dto.parentId },
    });
  }

  async remove(id: string) {
    await this.requireCategory(id);
    const [products, children] = await Promise.all([
      this.prisma.product.count({ where: { categoryId: id } }),
      this.prisma.category.count({ where: { parentId: id } }),
    ]);
    if (products || children) {
      throw new ConflictException('Category still has products or sub-categories');
    }
    await this.prisma.category.delete({ where: { id } });
  }

  private async requireCategory(id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }
}
