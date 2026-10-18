import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { LocationsService } from './locations.service';
import { ReservationService } from './reservation.service';
import { StoresController } from './stores.controller';

@Module({
  controllers: [InventoryController, StoresController],
  providers: [InventoryService, LocationsService, ReservationService],
  exports: [ReservationService], // used by checkout in Phase 4
})
export class InventoryModule {}
