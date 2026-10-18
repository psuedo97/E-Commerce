import { ProductStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength,
  Min, MinLength, ValidateNested,
} from 'class-validator';

export const GST_RATES = [0, 5, 12, 18, 28];

export class CreateCategoryDto {
  @IsString() @MinLength(2) @MaxLength(60)
  name: string;

  @IsOptional() @IsString()
  parentId?: string;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60)
  name?: string;

  @IsOptional() @IsString()
  parentId?: string;
}

// Prices are integers in paise (Rs 499 = 49900).
export class VariantDto {
  @IsString() @MinLength(2) @MaxLength(40)
  sku: string;

  @IsOptional() @IsString() @MaxLength(40)
  barcode?: string;

  @IsInt() @Min(1)
  mrp: number;

  @IsInt() @Min(1)
  price: number;

  @IsObject()
  attributes: Record<string, string>;
}

export class UpdateVariantDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(40) sku?: string;
  @IsOptional() @IsString() @MaxLength(40) barcode?: string;
  @IsOptional() @IsInt() @Min(1) mrp?: number;
  @IsOptional() @IsInt() @Min(1) price?: number;
  @IsOptional() @IsObject() attributes?: Record<string, string>;
}

export class CreateProductDto {
  @IsString() @MinLength(2) @MaxLength(160)
  title: string;

  @IsString() @MinLength(2) @MaxLength(5000)
  description: string;

  @IsOptional() @IsString() @MaxLength(80)
  brand?: string;

  @IsOptional() @Matches(/^\d{4,8}$/, { message: 'hsnCode must be 4 to 8 digits' })
  hsnCode?: string;

  @IsOptional() @IsInt() @IsIn(GST_RATES)
  gstRate?: number;

  @IsString()
  categoryId: string;

  @IsOptional() @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => VariantDto)
  variants: VariantDto[];
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(5000) description?: string;
  @IsOptional() @IsString() @MaxLength(80) brand?: string;
  @IsOptional() @Matches(/^\d{4,8}$/) hsnCode?: string;
  @IsOptional() @IsInt() @IsIn(GST_RATES) gstRate?: number;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsEnum(ProductStatus) status?: ProductStatus;
}

export const SORTS = ['newest', 'price_asc', 'price_desc'] as const;

export class ListProductsQuery {
  @IsOptional() @IsString() @MaxLength(80)
  search?: string;

  @IsOptional() @IsString()
  category?: string; // category slug; includes its sub-categories

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  minPrice?: number; // paise

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  maxPrice?: number; // paise

  @IsOptional() @IsIn(SORTS)
  sort?: (typeof SORTS)[number];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(48)
  limit?: number;
}

export class AdminListProductsQuery extends ListProductsQuery {
  @IsOptional() @IsEnum(ProductStatus)
  status?: ProductStatus;
}
