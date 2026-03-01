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
    // Use forRootAsync to inject ConfigService and read from Coolify env vars
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
    BullModule.registerQueue({
      name: 'servers-cron',
      defaultJobOptions: {
        removeOnComplete: true,
      },
    }),
  ],
})
export class ServerModule {}
