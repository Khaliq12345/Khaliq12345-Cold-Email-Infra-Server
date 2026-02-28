import { Module } from '@nestjs/common';
import { SharedModule } from 'src/shared/shared.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { ConfigModule } from '@nestjs/config';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  imports: [SharedModule, ConfigModule],
  exports: [AuthGuard, AuthGuard],
})
export class AuthModule {}
