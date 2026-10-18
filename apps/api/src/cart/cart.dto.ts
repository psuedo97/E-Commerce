import { IsInt, IsString, Max, Min } from 'class-validator';
import { MAX_LINE_QUANTITY } from '../orders/pricing';

export class AddItemDto {
  @IsString()
  variantId: string;

  @IsInt() @Min(1) @Max(MAX_LINE_QUANTITY)
  quantity: number;
}

export class SetQuantityDto {
  @IsInt() @Min(1) @Max(MAX_LINE_QUANTITY)
  quantity: number;
}

export class MergeCartDto {
  @IsString()
  guestCartId: string;
}
