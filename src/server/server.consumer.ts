import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SharedService } from 'src/shared/shared.service';
import { ServerService } from './server.service';

@Processor('servers-cron', {
  concurrency: 10,
})
export class ServerCronConsumer extends WorkerHost {
  private readonly logger = new Logger(ServerCronConsumer.name);

  constructor(
    private readonly sharedService: SharedService,
    private readonly serverService: ServerService,
  ) {
    super();
  }

  async process(job: Job<any>): Promise<void> {
    switch (job.name) {
      case 'setup-dkim': {
        const { domainName, serverName } = job.data;

        this.logger.log(
          `Processing DKIM for ${domainName} on ${serverName}...`,
        );

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

      case 'map-domain-to-server': {
        const { masterRelayIp, domainName, childRelayIp } = job.data;

        // 1. Define strict IPv4 Regex
        const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;

        // 2. Comprehensive Validation (Checks for null, undefined, strings, and format)
        const isInvalidIp = (ip: any) =>
          !ip || ip === 'undefined' || ip === 'null' || !ipv4Regex.test(ip);

        if (isInvalidIp(masterRelayIp) || isInvalidIp(childRelayIp)) {
          const errorMsg = `Aborting job: Invalid IP coordinates. Master: ${masterRelayIp}, Child: ${childRelayIp}`;
          this.logger.error(`❌ ${errorMsg}`);
          return;
        }

        this.logger.log(
          `🚀 Starting mapping for ${domainName} to ${childRelayIp} on Master ${masterRelayIp}`,
        );

        try {
          // This service likely uses the 'relay' user and port 6666 defined in your inventory
          await this.serverService.setupMasterRelayMapping(
            masterRelayIp,
            domainName,
            childRelayIp,
          );

          await this.sharedService
            .SupabaseClient()
            .from('domains')
            .update({ is_mapped_to_relay: true })
            .eq('domain', domainName);

          this.logger.log(
            `✅ Successfully mapped and updated status for ${domainName}`,
          );
        } catch (error) {
          this.logger.error(
            `❌ Failed to map domain for ${domainName} to ${childRelayIp}: ${error.message}`,
          );
          throw error;
        }
        break;
      }
    }
  }
}
