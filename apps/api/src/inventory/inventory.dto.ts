import { AdjustReason, StockMovementType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean, IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, NotEquals,
} from 'class-validator';
import { PINCODE_REGEX } from '../common/indian-states';

const MAX_QTY = 100_000;

export class CreateLocationDto {
  @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @IsOptional() @IsBoolean()
  isStore?: boolean; // false = warehouse

  @IsString() @MinLength(3) @MaxLength(200)
  address: string;

  @Matches(PINCODE_REGEX, { message: 'pincode must be 6 digits' })
  pincode: string;
}

export class UpdateLocationDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() isStore?: boolean;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) address?: string;
  @IsOptional() @Matches(PINCODE_REGEX) pincode?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

/** Identify the variant by id, or by scanning a barcode / typing a SKU (`code`). One of the two is required. */
export class VariantRefDto {
  @IsOptional() @IsString()
  variantId?: string;

  @IsOptional() @IsString() @MaxLength(60)
  code?: string;
}

export class ReceiveDto extends VariantRefDto {
  @IsString()
  locationId: string;

  @IsInt() @Min(1) @Max(MAX_QTY)
  quantity: number;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class AdjustDto extends VariantRefDto {
  @IsString()
  locationId: string;

  @IsInt() @NotEquals(0) @Min(-MAX_QTY) @Max(MAX_QTY)
  delta: number; // positive adds, negative removes

  @IsEnum(AdjustReason)
  reason: AdjustReason;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class CountDto extends VariantRefDto {
  @IsString()
  locationId: string;

  @IsInt() @Min(0) @Max(MAX_QTY)
  counted: number; // the physically counted quantity; on-hand is set to this

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class TransferDto extends VariantRefDto {
  @IsString()
  fromLocationId: string;

  @IsString()
  toLocationId: string;

  @IsInt() @Min(1) @Max(MAX_QTY)
  quantity: number;

  @IsOptional() @IsString() @MaxLength(300)
  note?: string;
}

export class ListInventoryQuery {
  @IsOptional() @IsString() @MaxLength(80)
  search?: string; // product title, SKU or barcode

  @IsOptional() @IsString()
  locationId?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  lowStock?: number; // only variants whose total available is <= this

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}

export class MovementsQuery {
  @IsOptional() @IsString() variantId?: string;
  @IsOptional() @IsString() locationId?: string;
  @IsOptional() @IsEnum(StockMovementType) type?: StockMovementType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
