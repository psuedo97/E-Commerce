import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { mailerProvider } from '../mail/mailer';
import { gatewayProvider } from './gateway.provider';
import { PaymentsController } from './payments.controller';
import { PaymentsScheduler } from './payments.scheduler';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

@Module({
  imports: [InventoryModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, RefundsService, PaymentsScheduler, gatewayProvider, mailerProvider],
  exports: [PaymentsService, RefundsService],
})
export class PaymentsModule {}
