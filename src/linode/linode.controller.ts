import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AddArecordDto } from './addArecord.dto';
import { LinodeService } from './linode.service';
import { AuthGuard } from 'src/auth/auth.guard';
import { createSupportTicketDto } from './create-support.dto';

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

  @UseGuards(AuthGuard)
  @Post('support/ticket')
  async openTicket(@Body() body: createSupportTicketDto) {
    try {
      this.service.openSupportTicket(body.linodeId, body.domain);
    } catch (error) {
      return error.message;
    }
  }
}
