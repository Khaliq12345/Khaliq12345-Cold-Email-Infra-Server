import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SharedService } from 'src/shared/shared.service';
import { ServerService } from './server.service';

@Processor('dkim-provisioning', {
  concurrency: 10,
})
export class DkimProvisioningConsumer extends WorkerHost {
  private readonly logger = new Logger(DkimProvisioningConsumer.name);

  constructor(
    private readonly sharedService: SharedService,
    private readonly serverService: ServerService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    const { domainName, serverName } = job.data;

    this.logger.log(`Processing DKIM for ${domainName} on ${serverName}...`);

    try {
      // 1. Run the Ansible/DKIM logic
      await this.serverService.assignAndSetupDkim(domainName, serverName);

      // 2. Update DB upon success
      const { error } = await this.sharedService
        .SupabaseClient()
        .from('domains')
        .update({ is_dkim_configured_in_server: true })
        .eq('domain', domainName);

      if (error) throw error;

      this.logger.log(`✅ Successfully provisioned DKIM for ${domainName}`);
    } catch (error) {
      this.logger.error(
        `❌ Failed to provision DKIM for ${domainName}: ${error.message}`,
      );
      // Throwing the error here tells BullMQ the job failed, triggering a retry
      throw error;
    }
  }
}
