import { Module } from '@nestjs/common';
import { ServerService } from 'src/server/server.service';
import { ServerController } from 'src/server/server.controller';
import { ServerCronService } from './server.cron';
import { SharedModule } from 'src/shared/shared.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from 'src/auth/auth.module';
import { DkimProvisioningConsumer } from './server.consumer';
import { BullModule } from '@nestjs/bullmq';

@Module({
  providers: [ServerService, ServerCronService, DkimProvisioningConsumer],
  controllers: [ServerController],
  imports: [
    SharedModule,
    ConfigModule,
    AuthModule,
    BullModule.forRoot({
      connection: { host: 'localhost', port: 6379 },
    }),
    BullModule.registerQueue({
      name: 'dkim-provisioning',
    }),
  ],
})
export class ServerModule {}
