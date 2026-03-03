import {
  Controller,
  Post,
  Body,
  UseGuards,
  BadRequestException,
  InternalServerErrorException,
  HttpCode,
  HttpStatus,
  Get,
  Query,
  Put,
} from '@nestjs/common';
import { AddArecordDto } from './addArecord.dto';
import { LinodeService } from './linode.service';
import { AuthGuard } from 'src/auth/auth.guard';
import { createSupportTicketDto } from './create-support.dto';
import { CreateServerDto } from './createServer.dto';
import { configureRdnDto } from './configureRdns.dto';

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
      this.service.oenSupportTicket(body.linodeId, body.domain);
    } catch (error) {
      return error.message;
    }
  }

  @UseGuards(AuthGuard)
  @Post('create-domain')
  async createDomain(@Body('domain') domain: string) {
    if (!domain) {
      throw new BadRequestException(
        'Domain string is required in the request body',
      );
    }

    try {
      const response = await this.service.ensureDomainExists(domain);

      return {
        status: 'success',
        domainId: response,
      };
    } catch (error) {
      throw new InternalServerErrorException(
        error.message || 'Failed to create Linode domain',
      );
    }
  }

  @UseGuards(AuthGuard)
  @Post('create-zone')
  @HttpCode(HttpStatus.CREATED)
  async createZone(
    @Body()
    createZoneDto: {
      domainName: string;
      mailServerDomain: string;
      relayServerIp: string;
    },
  ) {
    try {
      const result = await this.service.setupDomainDns(
        createZoneDto.domainName,
        createZoneDto.mailServerDomain,
        createZoneDto.relayServerIp,
      );

      return {
        success: true,
        message: `Zone for ${createZoneDto.domainName} created with filtered records (excluding NS, SOA, and DKIM).`,
        data: result,
      };
    } catch (error) {
      // Extracting the error message from the Axios/Hetzner response if it exists
      const errorMessage =
        error.response?.data?.error?.message || error.message;
      throw new InternalServerErrorException(
        `Linode API Error: ${errorMessage}`,
      );
    }
  }

  @UseGuards(AuthGuard)
  @Post('dkim')
  @HttpCode(HttpStatus.CREATED)
  async addDkimRecord(
    @Body() body: { domainName: string; selector: string; publicKey: string },
  ) {
    try {
      const result = await this.service.addDkimRecord(
        body.domainName,
        body.selector,
        body.publicKey,
      );

      return {
        success: true,
        message: `Zone for ${body.domainName} updated with dkim records`,
        data: result,
      };
    } catch (error) {
      const errorMessage =
        error.response?.data?.error?.message || error.message;
      throw new InternalServerErrorException(
        `Linode API Error: ${errorMessage}`,
      );
    }
  }

  // SERVER

  @UseGuards(AuthGuard)
  @Get('type')
  async getLinodeTypes() {
    const response = await this.service.getLinodesTypes();
    return { status: 'success', data: response.data };
  }

  @UseGuards(AuthGuard)
  @Get('get-sever')
  async getLinodeServer(@Query('label') label: string) {
    const response = await this.service.getLinodeServer(label);
    return { status: 'success', data: response.data };
  }

  @UseGuards(AuthGuard)
  @Post('create-server')
  async createLinodeServer(@Body() createServerDto: CreateServerDto) {
    const response = await this.service.createLinode(
      createServerDto.hostname,
      createServerDto.domain,
      createServerDto.parentIp,
      createServerDto.serverType,
    );

    return { status: 'success', data: response };
  }

  @UseGuards(AuthGuard)
  @Put('reverse-dns')
  async configureReverseDns(@Body() body: configureRdnDto) {
    const response = await this.service.configureReverseDns(
      body.linodeId,
      body.ipAddress,
      body.relayHostname,
    );

    return { status: 'success', data: response };
  }
}
