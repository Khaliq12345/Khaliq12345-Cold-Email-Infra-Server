import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PlusvibeService } from './plusvibe.service';
import { AuthGuard } from 'src/auth/auth.guard';

@Controller('plusvibe')
export class PlusvibeController {
  constructor(private service: PlusvibeService) {}

  @UseGuards(AuthGuard)
  @Get('workspaces')
  async findAllWorkspaces(
    @Query('username') username: string,
  ): Promise<Object[]> {
    return await this.service.getWorkspaces(username);
  }

  @UseGuards(AuthGuard)
  @Post('workspace/add-mailboxes')
  async addMailboxesToWorkspace(
    @Body() data: { domains: string[]; workspaceId: string },
  ) {
    // 1. Presence validation
    if (
      !data.domains ||
      !Array.isArray(data.domains) ||
      data.domains.length === 0
    ) {
      throw new BadRequestException('A list of domains is required');
    }

    // 2. Limit validation (Max 500)
    const domains = data.domains.slice(0, 500);

    // 3. Workspace ID validation
    if (!data.workspaceId) {
      throw new BadRequestException('Workspace ID is required');
    }

    return await this.service.queueSendMailboxesToWorkspace(
      domains,
      data.workspaceId,
    );
  }

  @UseGuards(AuthGuard)
  @Post('user/apikey')
  @HttpCode(HttpStatus.OK)
  async updateApiKey(@Body() body: { username: string; apiKey: string }) {
    return await this.service.updatePlusVibeApiKey(body.username, body.apiKey);
  }

  @UseGuards(AuthGuard)
  @Put('domain/link-workspace')
  async linkDomain(@Body() body: { domain: string; workspaceId: string }) {
    return await this.service.linkWorkspaceToDomain(
      body.domain,
      body.workspaceId,
    );
  }
}
