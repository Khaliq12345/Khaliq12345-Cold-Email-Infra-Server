import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StripeService } from './stripe.service';
import { StripeController } from './stripe.controller';
import { SharedModule } from 'src/shared/shared.module';
import { DomainModule } from 'src/domain/domain.module';

@Module({
  imports: [ConfigModule, SharedModule, DomainModule],
  controllers: [StripeController],
  providers: [StripeService],
})
export class StripeModule {}
