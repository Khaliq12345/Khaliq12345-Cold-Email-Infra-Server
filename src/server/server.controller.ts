import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServerService } from 'src/server/server.service';
import { CreateServerDto } from './createServer.dto';
import { configureRdnDto } from './configureRdns.dto';
import { AuthGuard } from 'src/auth/auth.guard';

@Controller('servers')
export class ServerController {
  constructor(private readonly serverService: ServerService) {}

  @UseGuards(AuthGuard)
  @Get('type')
  async getLinodeTypes() {
    const response = await this.serverService.getLinodesTypes();
    return { status: 'success', data: response.data };
  }

  @UseGuards(AuthGuard)
  @Get('relay')
  async getLinodeServer(@Query('label') label: string) {
    const response = await this.serverService.getLinodeServer(label);
    return { status: 'success', data: response.data };
  }

  @UseGuards(AuthGuard)
  @Post('relay')
  async createRelayServer(@Body() createServerDto: CreateServerDto) {
    const response = await this.serverService.createLinode(
      createServerDto.relayHostname,
      createServerDto.relayDomain,
      createServerDto.mailDomain,
      createServerDto.parentRelayIp,
    );

    return { status: 'success', data: response };
  }

  @UseGuards(AuthGuard)
  @Put('reverse-dns')
  async configureReverseDns(@Body() body: configureRdnDto) {
    const response = await this.serverService.configureReverseDns(
      body.linodeId,
      body.ipAddress,
      body.relayHostname,
    );

    return { status: 'success', data: response };
  }
}
