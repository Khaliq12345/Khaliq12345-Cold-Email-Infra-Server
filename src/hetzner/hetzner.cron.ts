import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SharedService } from 'src/shared/shared.service';
import { HetznerService } from './hetzner.service';

@Injectable()
export class HetznerCronService {
  private readonly logger = new Logger(HetznerCronService.name);

  constructor(
    private readonly sharedservice: SharedService,
    private readonly service: HetznerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'provisioning-basic-dns',
  })
  async handleBasicDnsProvisioning() {
    this.logger.log('Checking for domains needing Basic DNS setup...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch domains where basic_dns is false or null
    const { data: domains, error } = await client
      .from('domains')
      .select(
        'id, domain, username, basic_dns, relay_servers(ipaddress, master_mail_servers(*))',
      )
      .or('basic_dns.is.null,basic_dns.eq.false');

    if (error) {
      this.logger.error(
        `Supabase Error: ${error.message} (Code: ${error.code})`,
      );
      return;
    }

    if (!domains || domains.length === 0) {
      this.logger.debug('No domains found requiring Basic DNS setup.');
      return;
    }

    for (const record of domains) {
      try {
        this.logger.log(`Setting up Basic DNS for: ${record.domain}`);
        // 1. Safely extract values using optional chaining
        // This handles cases where relay_servers might be an empty array []
        const relay = record.relay_servers?.[0];
        const masterMailServer = relay?.master_mail_servers as any;

        // 2. Handle the "Array vs Object" response from Supabase
        const masterMailDomain = Array.isArray(masterMailServer)
          ? masterMailServer[0]?.domain
          : masterMailServer?.domain;

        const relayIp = relay?.ipaddress;

        // 3. Validation: Only proceed if we have the required data
        if (!masterMailDomain || !relayIp) {
          this.logger.warn(
            `Skipping DNS setup for ${record.domain}: Missing Relay IP or Master Mail Domain.`,
          );
          return; // Skip this iteration
        }

        // 4. Call the service with validated, typed data
        const response = await this.service.createZoneWithRecords(
          record.domain,
          masterMailDomain,
          relayIp,
        );

        if (response?.errors) {
          this.logger.error(
            `Failed to set Basic DNS for ${record.domain}: ${JSON.stringify(response.errors)}`,
          );
          continue; // Move to the next domain instead of killing the whole loop
        }

        if (response) {
          // 3. Update DB only if the API call was successful
          const { error: updateError } = await client
            .from('domains')
            .update({ basic_dns: true })
            .eq('id', record.id);

          if (!updateError) {
            this.logger.log(
              `✅ Basic DNS successfully set for ${record.domain}`,
            );
          } else {
            this.logger.error(
              `Database update failed for ${record.domain}: ${updateError.message}`,
            );
          }
        }
      } catch (e) {
        this.logger.error(
          `Exception during Basic DNS setup for ${record.domain}: ${e.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleDkimDnsProvisioning() {
    this.logger.log('Checking for domains needing DKIM DNS records...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch domains where we have a DKIM key but haven't set the DNS record yet
    const { data: domains, error } = await client
      .from('domains')
      .select('id, domain, dkim_value, is_dkim_set')
      .not('dkim_value', 'is', null)
      .is('basic_dns', true)
      .or('is_dkim_set.is.null,is_dkim_set.eq.false');

    if (error) {
      this.logger.error(`Supabase Error: ${error.message}`);
      return;
    }

    if (!domains || domains.length === 0) return;

    for (const record of domains) {
      try {
        this.logger.log(`Setting DKIM TXT record for ${record.domain}`);

        // 2. Call your existing DKIM DNS function
        // Assuming the function takes the domain and the public key string
        const response = await this.service.addDkimRecord(
          record.domain,
          'relay',
          record.dkim_value,
        );

        if (response?.errors) {
          this.logger.error(
            `Failed to set DKIM DNS for ${record.domain}: ${JSON.stringify(response.errors)}`,
          );
          continue;
        }

        if (response) {
          // 3. Update DB to prevent re-running this domain
          const { error: updateError } = await client
            .from('domains')
            .update({ is_dkim_set: true })
            .eq('id', record.id);

          if (!updateError) {
            this.logger.log(
              `✅ DKIM DNS record successfully set for ${record.domain}`,
            );
          }
        }
      } catch (e) {
        this.logger.error(
          `Exception during DKIM DNS setup for ${record.domain}: ${e.message}`,
        );
      }
    }
  }
}
