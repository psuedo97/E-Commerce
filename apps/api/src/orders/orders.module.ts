import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CartModule } from '../cart/cart.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ServiceabilityService } from '../shipping/serviceability.service';
import { ShippingController } from '../shipping/shipping.controller';
import { CheckoutService } from './checkout.service';
import { OrdersController } from './orders.controller';
import { OrdersScheduler } from './orders.scheduler';
import { OrdersService } from './orders.service';

@Module({
  imports: [ScheduleModule.forRoot(), InventoryModule, CartModule],
  controllers: [OrdersController, ShippingController],
  providers: [CheckoutService, OrdersService, OrdersScheduler, ServiceabilityService],
  exports: [OrdersService],
})
export class OrdersModule {}
