import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SharedService } from 'src/shared/shared.service';
import { MailcowService } from './mailcow.service';

@Injectable()
export class MailcowCronService {
  private readonly logger = new Logger(MailcowCronService.name);

  constructor(
    private readonly sharedservice: SharedService,
    private readonly service: MailcowService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleMailcowDomainCreation() {
    this.logger.log('Checking for domains needing Mailcow initialization...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Updated Select: Pull master_mail_servers directly from the domains table
    const { data: domains, error } = await client
      .from('domains')
      .select(
        `
      id, 
      domain, 
      mailcow_domain_created, 
      master_mail_servers(domain)
    `,
      )
      .is('paid', true)
      .is('is_dkim_set', true)
      .or('mailcow_domain_created.is.null,mailcow_domain_created.eq.false')
      .not('master_mail_server', 'is', null);

    if (error) {
      this.logger.error(`Supabase Error: ${error.message}`);
      return;
    }

    if (!domains || domains.length === 0) return;

    for (const record of domains) {
      try {
        this.logger.log(`Creating Mailcow domain for ${record.domain}`);

        // 2. Direct Extraction: Get the Master Domain from the top-level record
        const masterData = Array.isArray(record.master_mail_servers)
          ? record.master_mail_servers[0]
          : record.master_mail_servers;

        const masterMailDomain = masterData?.domain;

        // 3. Validation
        if (!masterMailDomain) {
          this.logger.warn(
            `Skipping ${record.domain}: No Master Mail Server domain found.`,
          );
          continue; // Move to next record
        }

        // 4. API Call: Create the domain in the specific Mailcow instance
        const response = await this.service.createDomain(
          masterMailDomain,
          record.domain,
        );

        // Handle specific Mailcow API response formats
        if (response?.errors || response?.error || !response) {
          this.logger.error(
            `Mailcow API Error for ${record.domain}: ${JSON.stringify(response || 'No response')}`,
          );
          continue;
        }

        // 5. Update DB upon success
        const { error: updateError } = await client
          .from('domains')
          .update({ mailcow_domain_created: true })
          .eq('id', record.id);

        if (updateError) throw updateError;

        this.logger.log(
          `✅ Mailcow domain created successfully for ${record.domain}`,
        );
      } catch (e) {
        this.logger.error(
          `Failed to process Mailcow for ${record.domain}: ${e.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleMailcowRelaySetup() {
    this.logger.log('Checking for domains needing Mailcow Relay Host setup...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch domains
    const { data: domains, error } = await client
      .from('domains')
      .select(
        `
      id,
      domain,
      master_mail_servers ( domain, relay_host_id )
    `,
      )
      .is('paid', true)
      .or('mailcow_relay_set.is.null,mailcow_relay_set.eq.false')
      .is('mailcow_domain_created', true);

    if (error) {
      this.logger.error(`Supabase Error: ${error.message}`);
      return;
    }

    if (!domains || domains.length === 0) return;

    for (const record of domains) {
      try {
        // Extracting nested data safely
        const masterMailData = Array.isArray(record.master_mail_servers)
          ? record.master_mail_servers[0]
          : record.master_mail_servers;

        const masterRelayId = masterMailData?.relay_host_id;
        const masterMailDomain = masterMailData?.domain;

        // 3. Validation
        if (!masterRelayId || !masterMailDomain) {
          this.logger.warn(
            `Skipping ${record.domain}: Missing MasterRelayId (${masterRelayId}) or MasterMailDomain (${masterMailDomain})`,
          );
          continue; // ❗ Use 'continue' to move to the next domain, NOT 'return'
        }

        this.logger.log(
          `🚀 Setting Relay Host for ${record.domain} to ID: ${masterRelayId}`,
        );

        // 4. Call Mailcow API
        const response = await this.service.setDomainTransport(
          record.domain,
          masterRelayId,
          masterMailDomain,
        );

        // Mailcow API typically returns an array of status objects
        const hasError = Array.isArray(response)
          ? response.some((r) => r.type === 'error')
          : response?.errors || response?.error;

        if (hasError) {
          this.logger.error(
            `❌ Mailcow API Rejected ${record.domain}: ${JSON.stringify(response)}`,
          );
          continue;
        }

        // 5. Update Database upon success
        const { error: updateError } = await client
          .from('domains')
          .update({ mailcow_relay_set: true })
          .eq('id', record.id);

        if (updateError) {
          this.logger.error(
            `⚠️ DB Update Failed for ${record.domain}: ${updateError.message}`,
          );
        } else {
          this.logger.log(
            `✅ Mailcow Relay Host configured for ${record.domain}`,
          );
        }
      } catch (e) {
        this.logger.error(`💥 Exception for ${record.domain}: ${e.message}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleMasterRelaySetup() {
    this.logger.log(
      'Checking Master Mail Servers for missing Relay Host IDs...',
    );

    const client = this.sharedservice.SupabaseClient();

    // Your correct query
    const { data: records, error } = await client
      .from('master_mail_servers')
      .select(
        `
      id,
      domain,
      master_relay,
      relay_host_id,
      master_relay_servers(ip_address)
    `,
      )
      .not('master_relay', 'is', null)
      .not('api_key', 'is', null)
      .is('relay_host_id', null);

    if (error) {
      this.logger.error(`Supabase Query Error: ${error.message}`);
      return;
    }

    if (!records || records.length === 0) return;

    for (const record of records) {
      try {
        // Extract IP from the joined master_relay_servers
        const relayData = Array.isArray(record.master_relay_servers)
          ? record.master_relay_servers[0]
          : record.master_relay_servers;

        if (!relayData?.ip_address) {
          this.logger.warn(
            `No IP found for relay server linked to ${record.domain}`,
          );
          continue;
        }

        // Create the transport in Mailcow
        await this.service.createDomainTransport(
          record.domain,
          relayData.ip_address,
        );
        const relayHostId = await this.service.getRelayHostIdByHostname(
          record.domain,
          relayData.ip_address,
        );

        if (!relayHostId) {
          this.logger.error(
            `Could not extract ID from Mailcow for ${record.domain}`,
          );
          continue;
        }

        // Update the master_mail_servers table with the new ID
        const { error: updateError } = await client
          .from('master_mail_servers')
          .update({ relay_host_id: relayHostId.toString() })
          .eq('id', record.id);

        if (updateError) throw updateError;

        this.logger.log(
          `✅ Successfully mapped Relay ID ${relayHostId} to ${record.domain}`,
        );
      } catch (e) {
        this.logger.error(
          `Error processing master server ${record.domain}: ${e.message}`,
        );
      }
    }
  }
}
