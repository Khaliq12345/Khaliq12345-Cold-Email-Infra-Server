import { Module } from '@nestjs/common';
import { PlusvibeController } from './plusvibe.controller';
import { PlusvibeService } from './plusvibe.service';
import { SharedModule } from 'src/shared/shared.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from 'src/auth/auth.module';
import { PlusvibeCronService } from './plusvibe.cron';

@Module({
  controllers: [PlusvibeController],
  providers: [PlusvibeService, PlusvibeCronService],
  imports: [SharedModule, ConfigModule, AuthModule],
})
export class PlusvibeModule {}
