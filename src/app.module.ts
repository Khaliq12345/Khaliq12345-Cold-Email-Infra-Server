import { Module } from '@nestjs/common';
import { PlusvibeModule } from './plusvibe/plusvibe.module';
import { MailcowModule } from './mailcow/mailcow.module';
import { SharedModule } from './shared/shared.module';
import { ServerModule } from './server/server.module';
import { HetznerModule } from './hetzner/hetzner.module';
import { LinodeModule } from './linode/linode.module';
import { DomainModule } from './domain/domain.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { StripeModule } from './stripe/stripe.module';

@Module({
  imports: [
    PlusvibeModule,
    MailcowModule,
    SharedModule,
    ServerModule,
    HetznerModule,
    LinodeModule,
    DomainModule,
    StripeModule,
    AuthModule,
    ScheduleModule.forRoot(),
    ConfigModule.forRoot(),
  ],
})
export class AppModule {}
