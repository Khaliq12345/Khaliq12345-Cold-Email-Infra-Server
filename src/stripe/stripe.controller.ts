// stripe.controller.ts
import { Controller, Post, Body, Param, Get, UseGuards } from '@nestjs/common';
import { StripeService } from './stripe.service';
import { CreatePaymentLinkDto } from './create-payment-link.dto';
import { AuthGuard } from 'src/auth/auth.guard';

@Controller('payments')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  @UseGuards(AuthGuard)
  @Post('create-link')
  async createLink(@Body() createPaymentLinkDto: CreatePaymentLinkDto) {
    const { domains, username } = createPaymentLinkDto;

    // Call the service to generate the link
    const paymentLink = await this.stripeService.createPaymentLink(
      domains,
      username,
    );

    return {
      url: paymentLink.url,
      id: paymentLink.id,
    };
  }

  @UseGuards(AuthGuard)
  @Get('confirm/:sessionId')
  async confirmPayment(@Param('sessionId') sessionId: string) {
    try {
      const result = await this.stripeService.handleCheckoutSuccess(sessionId);
      return { message: 'Domain activated successfully', data: result };
    } catch (error) {
      return { message: 'Verification failed', error: error.message };
    }
  }
}
