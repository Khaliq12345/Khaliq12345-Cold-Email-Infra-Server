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

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handlePlusvibeSync() {
    this.logger.log('Starting Plusvibe synchronization cron...');

    // 1. Fetch domains where added_to_plusvibe is false or null
    // We also check for 'active' status as per your requirement
    const { data: domains, error } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .select('domain, username, master_mail_servers(domain)')
      .is('paid', true);

    if (error) {
      this.logger.error(`Failed to fetch pending domains: ${error.message}`);
      return;
    }

    if (!domains || domains.length === 0) {
      this.logger.log('No pending domains found for Plusvibe.');
      return;
    }

    this.logger.log(`Found ${domains.length} domains to add to Plusvibe.`);

    // 2. Loop through domains and call your service function
    for (const item of domains) {
      try {
        this.logger.debug(`Processing domain: ${item.domain}`);

        // Note: Using masterDomain as the mailserverHost as per common setup
        await this.service.sendMailboxesToWorkspace(
          item.domain,
          (item.master_mail_servers as any).domain,
          item.username,
        );

        this.logger.log(
          `Successfully added ${item.domain} mailboxes to Plusvibe.`,
        );
      } catch (err) {
        this.logger.error(
          `Failed to add ${item.domain} to Plusvibe: ${err.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async updateMailcowStatus() {
    this.logger.log('Starting Plusvibe mailbox update cron...');

    const { data: domains, error } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .select('domain, username, plusvibe_workspace')
      .eq('paid', true)
      .not('plusvibe_workspace', 'is', null);

    if (error) {
      this.logger.error(`Failed to fetch domains: ${error.message}`);
      return;
    }

    if (!domains || domains.length === 0) {
      this.logger.log('No domains available');
      return;
    }

    const uniqueWorkspaces = new Map();
    for (const item of domains) {
      if (!uniqueWorkspaces.has(item.plusvibe_workspace)) {
        uniqueWorkspaces.set(item.plusvibe_workspace, item);
      }
    }

    this.logger.log(
      `Found ${uniqueWorkspaces.size} unique workspaces to process.`,
    );

    for (const [workspaceId, item] of uniqueWorkspaces) {
      this.logger.log(
        `Processing unique workspace: ${workspaceId} (User: ${item.username})`,
      );

      try {
        const accounts = await this.service.listPlusvibeMailboxes(
          workspaceId,
          item.username,
        );

        this.logger.debug(
          `Found ${accounts?.length || 0} mailboxes for ${workspaceId}`,
        );

        if (!accounts || !Array.isArray(accounts)) continue;

        for (const account of accounts) {
          const email = account.email;
          const health =
            account.payload?.analytics?.health_scores?.[
              '7d_overall_warmup_health'
            ] ?? 0;
          const createdAt = account.timestamp_created;

          const warmup_days = Math.floor(
            (Date.now() - new Date(createdAt).getTime()) /
              (1000 * 60 * 60 * 24),
          );

          let status = 'warming';
          if (warmup_days > 30 && health < 90) {
            status = 'failed';
          } else if (health >= 98 && warmup_days >= 14) {
            status = 'ready';
          }

          this.logger.debug(`Updating ${email}: ${status} (${health}%)`);

          const { error: updateError } = await this.sharedService
            .SupabaseClient()
            .from('mailboxes')
            .update({
              status,
              health,
              warmup_days,
            })
            .ilike('email', email);

          if (updateError) {
            this.logger.error(
              `Update failed for ${email}: ${updateError.message}`,
            );
          }
        } // End of account loop
      } catch (err) {
        this.logger.error(
          `Error processing workspace ${workspaceId}: ${err.message}`,
        );
      }
    }
  }
}
