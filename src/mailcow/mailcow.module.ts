import { Module } from '@nestjs/common';
import { MailcowController } from './mailcow.controller';
import { MailcowService } from './mailcow.service';
import { SharedModule } from 'src/shared/shared.module';
import { MailcowCronService } from './mailcow.cron';
import { AuthModule } from 'src/auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { MailcowConsumer } from './mailcow.consumer';
import { BullModule } from '@nestjs/bullmq';

@Module({
  controllers: [MailcowController],
  providers: [MailcowService, MailcowCronService, MailcowConsumer],
  imports: [
    SharedModule,
    AuthModule,
    ConfigModule,
    BullModule.registerQueue({
      name: 'mailcow-consumer',
      defaultJobOptions: {
        removeOnComplete: true,
      },
    }),
  ],
})
export class MailcowModule {}
