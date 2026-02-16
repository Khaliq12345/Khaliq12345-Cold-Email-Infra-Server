import { Module } from '@nestjs/common';
import { LinodeService } from './linode.service';
import { LinodeController } from './linode.controller';
import { SharedModule } from 'src/shared/shared.module';
import { LinodeCronService } from './linode.cron';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  providers: [LinodeService, LinodeCronService],
  controllers: [LinodeController],
  imports: [SharedModule, ConfigModule, AuthModule],
})
export class LinodeModule {}
