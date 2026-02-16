import { Module } from '@nestjs/common';
import { SharedService } from './shared.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  providers: [SharedService],
  exports: [SharedService],
  imports: [ConfigModule],
})
export class SharedModule {}
