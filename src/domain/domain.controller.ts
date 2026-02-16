import {
  Controller,
  Get,
  InternalServerErrorException,
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
}
