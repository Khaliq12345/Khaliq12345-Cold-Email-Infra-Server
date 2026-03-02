import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MailcowService } from './mailcow.service';
import { CreateMailboxesDto } from './create-mailboxes.dto';
import { UpdateMailboxesDto } from './update-mailboxes-quota.dto';
import { createMailboxesDomainDto } from './create-mailboxes-domain.dto';
import { AuthGuard } from 'src/auth/auth.guard';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

@Controller('mailboxes')
export class MailcowController {
  constructor(
    private service: MailcowService,
    @InjectQueue('mailcow-consumer') private queueService: Queue,
  ) {}

  @UseGuards(AuthGuard)
  @Post('create')
  @HttpCode(201)
  async createMailboxes(@Body() createMailboxesDto: CreateMailboxesDto) {
    try {
      // Add to queue
      await this.queueService.add(
        'create-mailboxes',
        {
          firstname: createMailboxesDto.firstName,
          lastname: createMailboxesDto.lastName,
          domains: createMailboxesDto.domains,
          total: createMailboxesDto.total,
        },
        {
          attempts: 3,
          backoff: 5000,
        },
      );
      return { status: 'success', details: 'mailboxes creation started' };
    } catch (error) {
      return { status: 'failed', details: error };
    }
  }

  @UseGuards(AuthGuard)
  @Post('update')
  async updateMailboxesQuota(@Body() updateMailboxesDto: UpdateMailboxesDto) {
    console.log('DTO', updateMailboxesDto);
    const data = await this.service.updateMailboxesQuota(
      updateMailboxesDto.quota,
      updateMailboxesDto.masterMailServerDomain,
      updateMailboxesDto?.mailboxes,
      updateMailboxesDto?.domain,
    );

    return { status: 'success', details: 'mailboxe(s) updated', data: data };
  }

  @UseGuards(AuthGuard)
  @Get()
  async getMailboxes(
    @Query('domain') domain: string,
    @Query('masterMailServerDomain') masterMailServerDomain: string,
  ) {
    const data = await this.service.getMailboxes(
      domain,
      masterMailServerDomain,
    );

    return { status: 'success', data: data };
  }

  @UseGuards(AuthGuard)
  @Post('domain')
  async createDomain(@Body() body: createMailboxesDomainDto) {
    const result = await this.service.createDomain(
      body.masterMailServerDomain,
      body.domain,
    );
    return {
      success: true,
      message: `Domain ${body.domain} created successfully`,
      data: result,
    };
  }

  @UseGuards(AuthGuard)
  @Post('domain/assign-transport')
  async assignTransport(
    @Body()
    body: {
      domain: string;
      relayHostId: number;
      masterMailServerDomain: string;
    },
  ) {
    const { domain, relayHostId, masterMailServerDomain } = body;

    const result = await this.service.setDomainTransport(
      domain,
      relayHostId,
      masterMailServerDomain,
    );

    return {
      success: true,
      message: `Domain ${domain} is now routed through relay ID ${relayHostId}`,
      data: result,
    };
  }

  @UseGuards(AuthGuard)
  @Get(':domain')
  async getMailboxesDb(@Param('domain') domain: string) {
    return await this.service.getDatabaseMailboxesByDomain(domain);
  }
}
