import { Module } from '@nestjs/common';
import { DomainService } from './domain.service';
import { DomainController } from './domain.controller';
import { SharedModule } from 'src/shared/shared.module';
import { DomainCronService } from './domain.cron';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [SharedModule, AuthModule],
  providers: [DomainService, DomainCronService],
  controllers: [DomainController],
})
export class DomainModule {}
