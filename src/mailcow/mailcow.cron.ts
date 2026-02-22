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

  @Cron(CronExpression.EVERY_MINUTE)
  async handleMailcowDomainCreation() {
    this.logger.log('Checking for domains needing Mailcow initialization...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch domains where mailcow_domain_created is false or null
    // We also fetch the related mail server info which is often needed for the API call
    const { data: domains, error } = await client
      .from('domains')
      .select(
        'id, domain, mailcow_domain_created, relay_servers(ipaddress, master_mail_servers(domain))',
      )
      .or('mailcow_domain_created.is.null,mailcow_domain_created.eq.false');

    if (error) {
      this.logger.error(`Supabase Error: ${error.message}`);
      return;
    }

    if (!domains || domains.length === 0) return;

    for (const record of domains) {
      try {
        this.logger.log(`Creating Mailcow domain for ${record.domain}`);
        const relay = record.relay_servers?.[0];
        const masterMailServer = relay?.master_mail_servers as any;

        // 2. Handle the "Array vs Object" response from Supabase
        const masterMailDomain = Array.isArray(masterMailServer)
          ? masterMailServer[0]?.domain
          : masterMailServer?.domain;

        // 3. Validation: Only proceed if we have the required data
        if (!masterMailDomain) {
          this.logger.warn(
            `Skipping DNS setup for ${record.domain}: Master Mail Domain.`,
          );
          return; // Skip this iteration
        }

        // 2. Call your Mailcow creation function
        const response = await this.service.createDomain(
          masterMailDomain,
          record.domain,
        );

        if (response?.errors || response?.error) {
          this.logger.error(
            `Mailcow API Error for ${record.domain}: ${JSON.stringify(response)}`,
          );
          continue;
        }

        if (response) {
          // 3. Update DB upon success
          const { error: updateError } = await client
            .from('domains')
            .update({ mailcow_domain_created: true })
            .eq('id', record.id);

          if (!updateError) {
            this.logger.log(
              `✅ Mailcow domain created successfully for ${record.domain}`,
            );
          }
        }
      } catch (e) {
        this.logger.error(
          `Failed to process Mailcow for ${record.domain}: ${e.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleMailcowRelaySetup() {
    this.logger.log('Checking for domains needing Mailcow Relay Host setup...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch domains where relay is not yet set
    // We need the hostname of the relay server to set as the transport
    const { data: domains, error } = await client
      .from('domains')
      .select(
        'id,domain,relay_servers(ipaddress, master_relay_servers(mailcow_relay_id), master_mail_servers(domain))',
      )
      .or('mailcow_relay_set.is.null,mailcow_relay_set.eq.false')
      .is('mailcow_domain_created', true);

    if (error) {
      this.logger.error(`Supabase Error: ${error.message}`);
      return;
    }

    if (!domains || domains.length === 0) return;

    for (const record of domains) {
      try {
        // 1. Safely extract values using optional chaining
        const relay = record.relay_servers?.[0];
        const masterRelayServer = relay?.master_relay_servers as any;
        const masterMailServer = relay?.master_mail_servers as any;

        const masterRelayId = Array.isArray(masterRelayServer)
          ? masterRelayServer[0]?.mailcow_relay_id
          : masterRelayServer?.mailcow_relay_id;

        const masterMailDomain = Array.isArray(masterMailServer)
          ? masterMailServer[0]?.domain
          : masterMailServer?.domain;

        this.logger.log(masterMailDomain);

        // 3. Validation: Only proceed if we have the required data
        if (!masterRelayId || !masterMailDomain) {
          this.logger.warn(
            `Skipping Relay setup for ${record.domain}: Master Relay Server Id or Master Mail Server Domain is not available`,
          );
          return; // Skip this iteration
        }

        this.logger.log(
          `Setting Relay Host for ${record.domain} to relay host - ${masterRelayId}`,
        );

        // 2. Call your Mailcow function to add the Relay Host
        // This typically maps the domain to a specific transport host
        const response = await this.service.setDomainTransport(
          record.domain,
          masterRelayId,
          masterMailDomain,
        );

        if (response?.errors || response?.error) {
          this.logger.error(
            `Mailcow Relay Error for ${record.domain}: ${JSON.stringify(response)}`,
          );
          continue;
        }

        if (response) {
          // 3. Update DB
          const { error: updateError } = await client
            .from('domains')
            .update({ mailcow_relay_set: true })
            .eq('id', record.id);

          if (!updateError) {
            this.logger.log(
              `✅ Mailcow Relay Host configured for ${record.domain}`,
            );
          }
        }
      } catch (e) {
        this.logger.error(
          `Exception during Relay Host setup for ${record.domain}: ${e.message}`,
        );
      }
    }
  }
}
