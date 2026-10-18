import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Public list of shops customers can collect orders from. Warehouses and closed shops are not shown. */
@Controller('stores')
export class StoresController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.location.findMany({
      where: { active: true, isStore: true },
      select: { id: true, name: true, address: true, pincode: true },
      orderBy: { name: 'asc' },
    });
  }
}
