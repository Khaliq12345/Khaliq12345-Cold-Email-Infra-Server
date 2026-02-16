import { Module } from '@nestjs/common';
import { MailcowController } from './mailcow.controller';
import { MailcowService } from './mailcow.service';
import { SharedModule } from 'src/shared/shared.module';
import { MailcowCronService } from './mailcow.cron';
import { AuthModule } from 'src/auth/auth.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  controllers: [MailcowController],
  providers: [MailcowService, MailcowCronService],
  imports: [SharedModule, AuthModule, ConfigModule],
})
export class MailcowModule {}
