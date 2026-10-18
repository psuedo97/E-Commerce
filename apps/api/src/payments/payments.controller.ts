import {
  BadRequestException, Body, Controller, HttpCode, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import type { Request } from 'express';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { RefundDto, SimulatePaymentDto, VerifyPaymentDto } from './payments.dto';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}

  /** Customer: begin paying for one of their unpaid orders. */
  @Post('orders/:id/pay')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payments.startPayment(user.id, id);
  }

  /** Customer: the payment window reports success; we check the proof and confirm the order. */
  @Post('payments/verify')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyPaymentDto) {
    return this.payments.verifyCheckout(user.id, {
      providerOrderId: dto.razorpay_order_id,
      providerPaymentId: dto.razorpay_payment_id,
      signature: dto.razorpay_signature,
    });
  }

  /** Development only (404 when a real gateway is configured). */
  @Post('payments/simulate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  simulate(@CurrentUser() user: AuthUser, @Body() dto: SimulatePaymentDto) {
    return this.payments.simulate(user.id, dto.orderId, dto.outcome);
  }

  /** Razorpay calls this. Public, but every request must carry a valid signature over the raw body. */
  @Post('webhooks/razorpay')
  @HttpCode(200)
  @SkipThrottle()
  webhook(@Req() req: RawBodyRequest<Request>) {
    if (!req.rawBody) throw new BadRequestException('Missing request body');
    const signature = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'];
    return this.payments.handleWebhook(
      req.rawBody,
      typeof signature === 'string' ? signature : undefined,
      typeof eventId === 'string' ? eventId : undefined,
    );
  }

  /** Admin: refund a paid order, fully or partly. */
  @Post('admin/orders/:id/refund')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async refund(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RefundDto) {
    const refund = await this.refunds.refundOrder(user.id, id, dto);
    return {
      id: refund.id, status: refund.status, amount: refund.amount, reason: refund.reason,
      providerRefundId: refund.providerRefundId, lastError: refund.lastError,
    };
  }
}
