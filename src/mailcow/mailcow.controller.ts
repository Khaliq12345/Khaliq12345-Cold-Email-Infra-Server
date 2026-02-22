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

@Controller('mailboxes')
export class MailcowController {
  constructor(private service: MailcowService) {}

  @UseGuards(AuthGuard)
  @Post('create')
  @HttpCode(201)
  async createMailboxes(@Body() createMailboxesDto: CreateMailboxesDto) {
    await this.service.createMailboxes(
      createMailboxesDto.domain,
      createMailboxesDto.firstName,
      createMailboxesDto.lastName,
      createMailboxesDto.total,
    );

    return { status: 'success', details: 'mailboxes created' };
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
