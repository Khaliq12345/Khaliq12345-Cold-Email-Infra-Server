import { Module } from '@nestjs/common';
import { HetznerService } from './hetzner.service';
import { HetznerController } from './hetzner.controller';
import { HetznerCronService } from './hetzner.cron';
import { SharedModule } from 'src/shared/shared.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  controllers: [HetznerController],
  providers: [HetznerService, HetznerCronService],
  imports: [SharedModule, ConfigModule, AuthModule],
})
export class HetznerModule {}
