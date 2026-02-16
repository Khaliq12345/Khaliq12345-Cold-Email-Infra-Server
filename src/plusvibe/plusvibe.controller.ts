import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PlusvibeService } from './plusvibe.service';
import { AddMailboxesToWorkspaceDto } from './addMailboxesToWorkspace.dto';
import { AuthGuard } from 'src/auth/auth.guard';

@Controller('warmup')
export class PlusvibeController {
  constructor(private service: PlusvibeService) {}

  @UseGuards(AuthGuard)
  @Get('workspaces')
  async findAllWorkspaces(): Promise<Object[]> {
    return await this.service.getWorkspaces();
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
}
