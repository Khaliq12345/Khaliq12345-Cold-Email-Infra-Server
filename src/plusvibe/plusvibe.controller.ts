import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PlusvibeService } from './plusvibe.service';
import { AddMailboxesToWorkspaceDto } from './addMailboxesToWorkspace.dto';
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
  @Post('workspace/add')
  async addMailboxesToWorkspace(
    @Body() addMailboxesToWorkspaceDto: AddMailboxesToWorkspaceDto,
  ) {
    console.log(addMailboxesToWorkspaceDto);
    await this.service.sendMailboxesToWorkspace(
      addMailboxesToWorkspaceDto.domain,
      addMailboxesToWorkspaceDto.workspaceId,
      addMailboxesToWorkspaceDto.mailserverHost,
    );

    return { status: 'success', details: 'Mailboxes added to workspace' };
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
