import {
  Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { AddItemDto, MergeCartDto, SetQuantityDto } from './cart.dto';
import { CartActor, CartService } from './cart.service';

/** Logged in: the account's cart. Guest: the cart named by the X-Cart-Id header (returned as `id` by the API). */
function actorOf(req: Request & { user?: AuthUser }): CartActor {
  const header = req.headers['x-cart-id'];
  return { userId: req.user?.id, cartId: typeof header === 'string' ? header : undefined };
}

@Controller('cart')
@UseGuards(OptionalJwtAuthGuard)
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@Req() req: Request) {
    return this.cart.get(actorOf(req));
  }

  @Post('items')
  add(@Req() req: Request, @Body() dto: AddItemDto) {
    return this.cart.addItem(actorOf(req), dto.variantId, dto.quantity);
  }

  @Patch('items/:variantId')
  setQuantity(@Req() req: Request, @Param('variantId') variantId: string, @Body() dto: SetQuantityDto) {
    return this.cart.setQuantity(actorOf(req), variantId, dto.quantity);
  }

  @Delete('items/:variantId')
  remove(@Req() req: Request, @Param('variantId') variantId: string) {
    return this.cart.removeItem(actorOf(req), variantId);
  }

  @Delete()
  clear(@Req() req: Request) {
    return this.cart.clear(actorOf(req));
  }

  @Post('merge')
  @UseGuards(JwtAuthGuard)
  merge(@CurrentUser() user: AuthUser, @Body() dto: MergeCartDto) {
    return this.cart.merge(user.id, dto.guestCartId);
  }
}
