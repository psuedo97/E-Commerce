import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PHONE_REGEX } from '../common/indian-states';

export class RegisterDto {
  @IsString() @MinLength(2) @MaxLength(80)
  name: string;

  @IsEmail()
  email: string;

  @IsOptional() @Matches(PHONE_REGEX, { message: 'phone must be a 10-digit Indian mobile number' })
  phone?: string;

  @IsString() @MinLength(8) @MaxLength(72) // bcrypt ignores bytes past 72
  password: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString() @MaxLength(72)
  password: string;
}
