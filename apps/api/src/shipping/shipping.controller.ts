import { Controller, Get, Query } from '@nestjs/common';
import { Matches } from 'class-validator';
import { PINCODE_REGEX } from '../common/indian-states';
import { ServiceabilityService } from './serviceability.service';

class PincodeQuery {
  @Matches(PINCODE_REGEX, { message: 'pincode must be 6 digits' })
  pincode: string;
}

@Controller('shipping')
export class ShippingController {
  constructor(private readonly serviceability: ServiceabilityService) {}

  @Get('serviceability')
  check(@Query() query: PincodeQuery) {
    return this.serviceability.check(query.pincode);
  }
}
