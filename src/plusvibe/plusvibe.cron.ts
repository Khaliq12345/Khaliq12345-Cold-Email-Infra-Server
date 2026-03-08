import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SharedService } from 'src/shared/shared.service';
import { PlusvibeService } from './plusvibe.service';

@Injectable()
export class PlusvibeCronService {
  private readonly logger = new Logger(PlusvibeCronService.name);

  constructor(
    private readonly sharedService: SharedService,
    private readonly service: PlusvibeService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runGlobalVerificationSync() {
    this.logger.log(
      'Starting plusvibe mailboxes verification and database sync',
    );

    // 1. Find all domains stuck in 'VERIFYING'
    const { data: pendingDomains } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .select('domain, username, plusvibe_workspace')
      .eq('plusvibe_sync_status', 'SENDING');

    if (!pendingDomains?.length) return;

    for (const d of pendingDomains) {
      try {
        // 2. Perform the truth check
        const confirmed = await this.service.syncWorkspaceMailboxes(
          d.username,
          d.plusvibe_workspace,
          d.domain,
        );

        this.logger.log(`Verified ${confirmed} accounts for ${d.domain}`);
      } catch (err) {
        this.logger.error(`Cron sync failed for ${d.domain}: ${err.message}`);
      }
    }
  }
}
