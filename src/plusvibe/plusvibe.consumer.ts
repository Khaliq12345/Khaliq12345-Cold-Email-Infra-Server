import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PlusvibeService } from './plusvibe.service';

@Processor('plusvibe-cron', {
  concurrency: 10,
})
export class PlusvibeConsumer extends WorkerHost {
  private readonly logger = new Logger(PlusvibeConsumer.name);

  constructor(private readonly service: PlusvibeService) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    const { domains, workspaceId } = job.data;
    switch (job.name) {
      case 'add-mailboxes-to-workspace': {
        // 2. Loop through domains and call your service function
        for (const item of domains) {
          try {
            this.logger.debug(`Processing domain: ${item.domain}`);

            // Note: Using masterDomain as the mailserverHost as per common setup
            await this.service.sendMailboxesToWorkspace(
              item.domain,
              (item.master_mail_servers as any).domain,
              item.username,
              workspaceId,
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
    }
  }
}
