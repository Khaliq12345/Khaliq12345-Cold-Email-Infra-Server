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

  @Cron(CronExpression.EVERY_YEAR, {
    name: 'provisioning-basic-dns',
  })
  async handleBasicDnsProvisioning() {
    this.logger.log('Checking for domains needing Basic DNS setup...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Updated Select: Pull master_mail_servers directly from domains
    // Note: relay_servers is still likely a 1-to-1 or 1-to-many join
    const { data: domains, error } = await client
      .from('domains')
      .select(
        `
        id, 
        domain, 
        username, 
        basic_dns, 
        relay_servers(ipaddress), 
        master_mail_servers(domain)
      `,
      )
      .or('basic_dns.is.null,basic_dns.eq.false')
      .is('paid', true);

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

        // 2. Simplified Extraction: master_mail_servers is now a direct property of record
        // Supabase joins return objects for single relationships (if defined correctly in DB)
        // but we add a check just in case it returns an array.
        const masterData = Array.isArray(record.master_mail_servers)
          ? record.master_mail_servers[0]
          : record.master_mail_servers;

        const masterMailDomain = masterData?.domain;

        // Relay IP usually comes from an array in Supabase joins
        const relayData = Array.isArray(record.relay_servers)
          ? record.relay_servers[0]
          : record.relay_servers;

        const relayIp = relayData?.ipaddress;

        // 3. Validation
        if (!masterMailDomain || !relayIp) {
          this.logger.warn(
            `Skipping ${record.domain}: Missing Relay IP (${relayIp}) or Master Domain (${masterMailDomain}).`,
          );
          continue; // Use continue in a loop, not return
        }

        // 4. API Call
        const response = await this.service.createZoneWithRecords(
          record.domain,
          masterMailDomain,
          relayIp,
        );

        // Check for errors in your specific API implementation
        if (response?.errors || !response) {
          this.logger.error(
            `Failed to set Basic DNS for ${record.domain}: ${JSON.stringify(response?.errors || 'Unknown Error')}`,
          );
          continue;
        }

        // 5. Update DB
        const { error: updateError } = await client
          .from('domains')
          .update({ basic_dns: true })
          .eq('id', record.id);

        if (updateError) throw updateError;

        this.logger.log(`✅ Basic DNS successfully set for ${record.domain}`);
      } catch (e) {
        this.logger.error(
          `Exception during Basic DNS setup for ${record.domain}: ${e.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_YEAR)
  async handleDkimDnsProvisioning() {
    this.logger.log('Checking for domains needing DKIM DNS records...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch domains where we have a DKIM key but haven't set the DNS record yet
    const { data: domains, error } = await client
      .from('domains')
      .select('id, domain, dkim_value, is_dkim_set')
      .not('dkim_value', 'is', null)
      .is('basic_dns', true)
      .is('paid', true)
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
