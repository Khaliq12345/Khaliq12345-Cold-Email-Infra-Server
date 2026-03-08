import { Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PlusvibeService } from './plusvibe.service';

@Processor('plusvibe-cron', {
  concurrency: 5,
  lockDuration: 300000,
  stalledInterval: 60000,
})
export class PlusvibeConsumer extends WorkerHost {
  private readonly logger = new Logger(PlusvibeConsumer.name);

  constructor(
    private readonly service: PlusvibeService,
    @InjectQueue('plusvibe-cron') private queueService: Queue,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    if (job.name === 'add-domain-mailboxes-to-plusvibe') {
      const { domain, mailserverHost, username, workspaceId } = job.data;

      this.logger.log(`Starting sync for domain: ${domain}`);

      // This calls your "One-by-One Pre-check + Bulk Add" logic
      await this.service.sendMailboxesToWorkspace(
        domain,
        mailserverHost,
        username,
        workspaceId,
      );

      // 3. Queue the "Verification & Unlock" job to run in 1 hour
      await this.queueService.add(
        'verify-domain-mailboxes',
        { domain, workspaceId, username },
        {
          delay: 3600000,
          jobId: `verify-${domain}`,
          removeOnComplete: true,
        },
      );

      this.logger.log(`Completed sync for domain: ${domain}`);
    }

    if (job.name === 'verify-domain-mailboxes') {
      const { domain, workspaceId, username } = job.data;
      this.logger.log(
        `[Phase 2] One-hour mark reached. Verifying the mailboxes of domain - ${domain}`,
      );

      // 1. Run the "Truth Sync" (fetches /account/list and updates DB)
      await this.service.syncWorkspaceMailboxes(username, workspaceId, domain);

      // 2. Force status back to IDLE regardless of the count
      await this.service.updateDomainSyncStatus(domain, 'IDLE');

      this.logger.log(`Domain ${domain} mailboxes verified`);
    }
  }
}
