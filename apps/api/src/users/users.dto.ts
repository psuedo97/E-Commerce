import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { INDIAN_STATES, PHONE_REGEX, PINCODE_REGEX } from '../common/indian-states';

export class UpdateProfileDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80)
  name?: string;

  @IsOptional() @Matches(PHONE_REGEX, { message: 'phone must be a 10-digit Indian mobile number' })
  phone?: string;
}

export class AddressDto {
  @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @Matches(PHONE_REGEX, { message: 'phone must be a 10-digit Indian mobile number' })
  phone: string;

  @IsString() @MinLength(3) @MaxLength(200)
  line1: string;

  @IsOptional() @IsString() @MaxLength(200)
  line2?: string;

  @IsString() @MinLength(2) @MaxLength(80)
  city: string;

  @IsIn(INDIAN_STATES as readonly string[])
  state: string;

  @Matches(PINCODE_REGEX, { message: 'pincode must be 6 digits' })
  pincode: string;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @Matches(PHONE_REGEX) phone?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) line1?: string;
  @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) city?: string;
  @IsOptional() @IsIn(INDIAN_STATES as readonly string[]) state?: string;
  @IsOptional() @Matches(PINCODE_REGEX) pincode?: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
