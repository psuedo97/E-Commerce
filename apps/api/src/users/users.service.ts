import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AddressDto, UpdateAddressDto, UpdateProfileDto } from './users.dto';

const publicUser = { id: true, name: true, email: true, phone: true, role: true, createdAt: true } as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: publicUser });
    if (!user) throw new NotFoundException();
    return user;
  }

  async updateProfile(id: string, dto: UpdateProfileDto) {
    try {
      return await this.prisma.user.update({ where: { id }, data: dto, select: publicUser });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This phone number is already in use');
      }
      throw e;
    }
  }

  listAddresses(userId: string) {
    return this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
    });
  }

  async createAddress(userId: string, dto: AddressDto) {
    return this.prisma.$transaction(async (tx) => {
      // First address is always the default.
      const count = await tx.address.count({ where: { userId } });
      const isDefault = count === 0 || !!dto.isDefault;
      if (isDefault) await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      return tx.address.create({ data: { ...dto, userId, isDefault } });
    });
  }

  async updateAddress(userId: string, id: string, dto: UpdateAddressDto) {
    await this.findOwned(userId, id);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) await tx.address.updateMany({ where: { userId }, data: { isDefault: false } });
      return tx.address.update({ where: { id }, data: dto });
    });
  }

  async deleteAddress(userId: string, id: string) {
    const address = await this.findOwned(userId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id } });
      if (address.isDefault) {
        const next = await tx.address.findFirst({ where: { userId }, orderBy: { id: 'asc' } });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
  }

  // Lookup is scoped by userId, so someone else's address id returns 404, not 403.
  private async findOwned(userId: string, id: string) {
    const address = await this.prisma.address.findFirst({ where: { id, userId } });
    if (!address) throw new NotFoundException('Address not found');
    return address;
  }
}
