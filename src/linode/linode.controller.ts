import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AddArecordDto } from './addArecord.dto';
import { LinodeService } from './linode.service';
import { AuthGuard } from 'src/auth/auth.guard';

@Controller('linode')
export class LinodeController {
  constructor(private readonly service: LinodeService) {}

  @UseGuards(AuthGuard)
  @Post('a-record')
  async deploy(@Body() dto: AddArecordDto) {
    try {
      const response = await this.service.addArecord(
        dto.domain,
        dto.hostName,
        dto.ipAddress,
      );

      return {
        status: 'success',
        details: response,
      };
    } catch (error) {
      return error.message;
    }
  }
}
