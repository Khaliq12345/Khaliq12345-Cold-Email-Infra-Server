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
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StripeModule } from './stripe/stripe.module';
import { BullModule } from '@nestjs/bullmq';

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
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD'),
          username: configService.get<string>('REDIS_USERNAME'),
        },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class AppModule {}
