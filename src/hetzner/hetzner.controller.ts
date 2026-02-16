import {
  Controller,
  Post,
  Body,
  InternalServerErrorException,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { HetznerService } from './hetzner.service';
import { CreateZoneDto } from './createZoneDto.dto';
import { AddDkimDto } from './addDkimDto.dto';
import { AuthGuard } from 'src/auth/auth.guard';

@Controller('hetzner')
export class HetznerController {
  constructor(private readonly service: HetznerService) {}

  @UseGuards(AuthGuard)
  @Post('create-zone')
  @HttpCode(HttpStatus.CREATED)
  async createZone(@Body() createZoneDto: CreateZoneDto) {
    try {
      const result = await this.service.createZoneWithRecords(
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
        `Hetzner API Error: ${errorMessage}`,
      );
    }
  }


  @UseGuards(AuthGuard)
  @Post('dkim')
  @HttpCode(HttpStatus.CREATED)
  async addDkimRecord(@Body() body: AddDkimDto) {
    try {
      const result = await this.service.addDkimRecord(
        body.zoneName,
        body.selector,
        body.publicKey,
      );

      return {
        success: true,
        message: `Zone for ${body.zoneName} updated with dkim records`,
        data: result,
      };
    } catch (error) {
      // Extracting the error message from the Axios/Hetzner response if it exists
      const errorMessage =
        error.response?.data?.error?.message || error.message;
      throw new InternalServerErrorException(
        `Hetzner API Error: ${errorMessage}`,
      );
    }
  }
}
