import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLocationDto, UpdateLocationDto } from './inventory.dto';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.location.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] });
  }

  create(dto: CreateLocationDto) {
    return this.prisma.location.create({ data: { ...dto, name: dto.name.trim() } });
  }

  // No delete: locations are referenced by stock history. Deactivate instead.
  async update(id: string, dto: UpdateLocationDto) {
    const found = await this.prisma.location.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Location not found');
    return this.prisma.location.update({ where: { id }, data: { ...dto, name: dto.name?.trim() } });
  }
}
