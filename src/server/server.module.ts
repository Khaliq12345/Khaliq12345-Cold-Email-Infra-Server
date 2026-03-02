import { Module } from '@nestjs/common';
import { ServerService } from 'src/server/server.service';
import { ServerController } from 'src/server/server.controller';
import { ServerCronService } from './server.cron';
import { SharedModule } from 'src/shared/shared.module';
import { ConfigModule, ConfigService } from '@nestjs/config'; // Added ConfigService
import { AuthModule } from 'src/auth/auth.module';
import { ServerCronConsumer } from './server.consumer';
import { BullModule } from '@nestjs/bullmq';

@Module({
  providers: [ServerService, ServerCronService, ServerCronConsumer],
  controllers: [ServerController],
  imports: [
    SharedModule,
    ConfigModule,
    AuthModule,
    BullModule.registerQueue({
      name: 'servers-cron',
      defaultJobOptions: {
        removeOnComplete: true,
      },
    }),
  ],
})
export class ServerModule {}
