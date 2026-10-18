import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import {
  AdjustDto, CountDto, CreateLocationDto, ListInventoryQuery, MovementsQuery, ReceiveDto, TransferDto,
  UpdateLocationDto,
} from './inventory.dto';
import { InventoryService } from './inventory.service';
import { LocationsService } from './locations.service';

// Store staff run stock; only admins change locations.
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.STAFF)
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly locations: LocationsService,
  ) {}

  // locations
  @Get('locations')
  listLocations() {
    return this.locations.list();
  }

  @Post('locations')
  @Roles(Role.ADMIN)
  createLocation(@Body() dto: CreateLocationDto) {
    return this.locations.create(dto);
  }

  @Patch('locations/:id')
  @Roles(Role.ADMIN)
  updateLocation(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.locations.update(id, dto);
  }

  // stock levels
  @Get('inventory')
  list(@Query() query: ListInventoryQuery) {
    return this.inventory.list(query);
  }

  @Get('inventory/barcode/:code')
  byCode(@Param('code') code: string) {
    return this.inventory.byCode(code);
  }

  @Get('inventory/movements')
  movements(@Query() query: MovementsQuery) {
    return this.inventory.movements(query);
  }

  // stock changes
  @Post('inventory/receive')
  receive(@CurrentUser() user: AuthUser, @Body() dto: ReceiveDto) {
    return this.inventory.receive(user.id, dto);
  }

  @Post('inventory/adjust')
  adjust(@CurrentUser() user: AuthUser, @Body() dto: AdjustDto) {
    return this.inventory.adjust(user.id, dto);
  }

  @Post('inventory/count')
  count(@CurrentUser() user: AuthUser, @Body() dto: CountDto) {
    return this.inventory.count(user.id, dto);
  }

  @Post('inventory/transfer')
  transfer(@CurrentUser() user: AuthUser, @Body() dto: TransferDto) {
    return this.inventory.transfer(user.id, dto);
  }
}
