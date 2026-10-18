import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** What Razorpay's checkout window hands back after a successful payment. */
export class VerifyPaymentDto {
  @IsString() @MaxLength(100)
  razorpay_order_id: string;

  @IsString() @MaxLength(100)
  razorpay_payment_id: string;

  @IsString() @MaxLength(200)
  razorpay_signature: string;
}

export class SimulatePaymentDto {
  @IsString()
  orderId: string;

  @IsIn(['success', 'failure'])
  outcome: 'success' | 'failure';
}

export class RefundDto {
  /** Paise. Leave out to refund everything still refundable. */
  @IsOptional() @IsInt() @Min(1)
  amount?: number;

  @IsString() @MinLength(3) @MaxLength(200)
  reason: string;

  /** Full refunds only: also put the items back in stock. */
  @IsOptional() @IsBoolean()
  restock?: boolean;
}
