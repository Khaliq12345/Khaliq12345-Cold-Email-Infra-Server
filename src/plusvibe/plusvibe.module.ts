import { Module } from '@nestjs/common';
import { PlusvibeController } from './plusvibe.controller';
import { PlusvibeService } from './plusvibe.service';
import { SharedModule } from 'src/shared/shared.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from 'src/auth/auth.module';
import { PlusvibeCronService } from './plusvibe.cron';
import { BullModule } from '@nestjs/bullmq';
import { PlusvibeConsumer } from './plusvibe.consumer';

@Module({
  controllers: [PlusvibeController],
  providers: [PlusvibeService, PlusvibeCronService, PlusvibeConsumer],
  imports: [
    SharedModule,
    ConfigModule,
    AuthModule,
    BullModule.registerQueue({
      name: 'plusvibe-cron',
      defaultJobOptions: {
        removeOnComplete: true,
      },
    }),
  ],
})
export class PlusvibeModule {}
