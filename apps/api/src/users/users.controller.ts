import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AddressDto, UpdateAddressDto, UpdateProfileDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  profile(@CurrentUser() u: AuthUser) {
    return this.users.getProfile(u.id);
  }

  @Patch()
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(u.id, dto);
  }

  @Get('addresses')
  addresses(@CurrentUser() u: AuthUser) {
    return this.users.listAddresses(u.id);
  }

  @Post('addresses')
  addAddress(@CurrentUser() u: AuthUser, @Body() dto: AddressDto) {
    return this.users.createAddress(u.id, dto);
  }

  @Patch('addresses/:id')
  editAddress(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateAddressDto) {
    return this.users.updateAddress(u.id, id, dto);
  }

  @Delete('addresses/:id')
  @HttpCode(204)
  removeAddress(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.users.deleteAddress(u.id, id);
  }
}
