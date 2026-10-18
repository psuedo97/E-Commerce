import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { LocationsService } from './locations.service';
import { ReservationService } from './reservation.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, LocationsService, ReservationService],
  exports: [ReservationService], // used by checkout in Phase 4
})
export class InventoryModule {}
