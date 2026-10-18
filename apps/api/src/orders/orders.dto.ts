import { FulfilmentType, PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { PHONE_REGEX } from '../common/indian-states';

export class CheckoutDto {
  @IsEnum(FulfilmentType)
  fulfilment: FulfilmentType;

  /** One of the user's saved addresses. Required for delivery. */
  @ValidateIf((o: CheckoutDto) => o.fulfilment === 'SHIP')
  @IsString()
  addressId?: string;

  /** The shop to collect from. Required for store pickup. */
  @ValidateIf((o: CheckoutDto) => o.fulfilment === 'STORE_PICKUP')
  @IsString()
  pickupLocationId?: string;

  /** Who to call about a pickup. Defaults to the phone number on the account. */
  @IsOptional() @Matches(PHONE_REGEX, { message: 'contactPhone must be a 10-digit Indian mobile number' })
  contactPhone?: string;

  @IsOptional() @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;
}

export class ListOrdersQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit?: number;
}
