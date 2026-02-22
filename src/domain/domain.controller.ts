import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { DomainService } from './domain.service';
import { Post, Body } from '@nestjs/common';
import { CreateDomainDto } from './create-domain.dto';
import { AuthGuard } from '../auth/auth.guard';

@Controller('domains')
export class DomainController {
  constructor(private readonly service: DomainService) {}

  @Post()
  async create(@Body() body: CreateDomainDto) {
    const response = await this.service.addDomain(body.username, body.domain);

    return { status: 'success', data: response };
  }

  @UseGuards(AuthGuard)
  @Get()
  async getUserDomains(@Request() req: any) {
    try {
      const username = req.user.user_metadata.username;

      return await this.service.getDomainsByUser(username);
    } catch (error) {
      throw new InternalServerErrorException('Could not retrieve domains');
    }
  }

  @UseGuards(AuthGuard)
  @Get('check-availability')
  async checkAvailability(@Query('domain') domain: string) {
    if (!domain) {
      throw new BadRequestException('Domain name is required');
    }

    const isRegistered = await this.service.isDomainRegistered(domain);

    return {
      domain: domain,
      available: !isRegistered, // If it's not registered, it's available
      message: isRegistered
        ? 'Domain is already registered on the internet.'
        : 'Domain appears to be available.',
    };
  }

  @UseGuards(AuthGuard)
  @Get(':domain')
  async getUserDomain(@Param('domain') domain: string) {
    try {
      return await this.service.getDomainDetails(domain);
    } catch (error) {
      throw new InternalServerErrorException('Could not retrieve domains');
    }
  }

  @UseGuards(AuthGuard)
  @Get('stats/:username')
  async getUserStats(@Param('username') username: string) {
    return await this.service.getDomainStatsByUser(username);
  }
}
