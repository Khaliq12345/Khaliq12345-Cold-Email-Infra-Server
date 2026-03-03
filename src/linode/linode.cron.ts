import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SharedService } from 'src/shared/shared.service';
import { LinodeService } from './linode.service';

@Injectable()
export class LinodeCronService {
  private readonly logger = new Logger(LinodeCronService.name);
  constructor(
    private readonly sharedservice: SharedService,
    private readonly service: LinodeService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleARecordProvisioning() {
    this.logger.log('Checking for relay servers needing A-records...');

    // 1. Fetch servers where a_record_set is false

    const client = this.sharedservice.SupabaseClient();
    const { data: servers, error } = await client
      .from('relay_servers')
      .select(
        'server_name, ipaddress, a_record_set, hostname, master_relay_server(domain)',
      )
      .eq('status', 'awaiting_manual_review')
      .or('a_record_set.is.null,a_record_set.eq.false');

    // 1. Check if there is an error code
    if (error) {
      this.logger.error(
        `Supabase Error: ${error.message} (Code: ${error.code})`,
      );
      return;
    }

    for (const server of servers) {
      try {
        this.logger.log(
          `Setting A-record for ${server.server_name} -> ${server.ipaddress}`,
        );

        // 2. Call your existing A-Record function
        const response = await this.service.addArecord(
          (server.master_relay_server as any).domain,
          server.hostname,
          server.ipaddress,
        );
        if (response?.errors) {
          this.logger.error(
            `Failed to set A-record for ${server.server_name}: ${response}`,
          );
          return;
        }

        if (response) {
          // 3. Update DB only if the API call was successful
          const { error: updateError } = await client
            .from('relay_servers')
            .update({ a_record_set: true })
            .eq('server_name', server.server_name);

          if (!updateError) {
            this.logger.log(
              `✅ A-record successfully set for ${(server.master_relay_server as any).domain}`,
            );
          }
        }
      } catch (e) {
        this.logger.error(
          `Failed to set A-record for ${server.server_name}: ${e.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'provisioning-basic-dns',
  })
  async handleBasicDnsProvisioning() {
    this.logger.log('Checking for domains needing Basic DNS setup...');

    const client = this.sharedservice.SupabaseClient();

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

        const masterData = Array.isArray(record.master_mail_servers)
          ? record.master_mail_servers[0]
          : record.master_mail_servers;

        const masterMailDomain = masterData?.domain;

        const relayData = Array.isArray(record.relay_servers)
          ? record.relay_servers[0]
          : record.relay_servers;

        const relayIp = relayData?.ipaddress;

        // 3. Validation
        if (!masterMailDomain || !relayIp) {
          this.logger.warn(
            `Skipping ${record.domain}: Missing Relay IP (${relayIp}) or Master Domain (${masterMailDomain}).`,
          );
          continue;
        }

        // 4. API Call
        try {
          await this.service.setupDomainDns(
            record.domain,
            masterMailDomain,
            relayIp,
          );
        } catch (error) {
          this.logger.error(
            `Failed to set Basic DNS for ${record.domain}: ${JSON.stringify(error || 'Unknown Error')}`,
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

  @Cron(CronExpression.EVERY_5_MINUTES)
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

        // 2. Call existing DKIM DNS function
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

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'setup-mailserver-dns',
  })
  async syncMailServerDns() {
    this.logger.log('Checking for new mail servers requiring DNS setup...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch mail servers that haven't had DNS configured yet
    const { data: servers, error } = await client
      .from('master_mail_servers')
      .select('server_id, domain, ip_address, status')
      .eq('status', 'awaiting_manual_review')
      .is('is_dns_set', false);

    if (error) {
      this.logger.error(`Supabase Fetch Error: ${error.message}`);
      return;
    }

    for (const server of servers) {
      try {
        this.logger.log(`Setting up DNS for ${server.domain}`);

        // 2. Define the specific basic DNS records requested
        const basicRecords = [
          { name: '', type: 'A', target: server.ip_address },
          { name: 'mail', type: 'A', target: server.ip_address },
          {
            name: '',
            type: 'MX',
            target: server.domain,
            priority: 10,
          },
          {
            name: 'autoconfig',
            type: 'CNAME',
            target: server.domain,
          },
          {
            name: 'autodiscover',
            type: 'CNAME',
            target: server.domain,
          },
        ];

        // 3. Execute setup (using your default SRV logic inside the function)
        const dnsResult = await this.service.setupDomainDns(
          (server.domain as string).replace('mail.', ''),
          server.domain,
          server.ip_address,
          basicRecords,
        );

        if (dnsResult.success) {
          // 4. Update status so it doesn't run again
          await client
            .from('master_mail_servers')
            .update({ is_dns_set: true })
            .eq('server_id', server.server_id);

          this.logger.log(`DNS successfully configured for ${server.domain}`);
        }
      } catch (e) {
        this.logger.error(
          `Failed DNS setup for ${server.domain}: ${e.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'sync-server-status',
  })
  async syncServerStatuses() {
    this.logger.log('Syncing server statuses with Linode...');

    // Sync both tables independently
    await this.processTableSync('relay_servers');
    await this.processTableSync('master_mail_servers');
  }

  /**
   * Generic helper to process status updates for different tables
   */
  private async processTableSync(
    tableName: 'relay_servers' | 'master_mail_servers',
  ) {
    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch pending servers
    const columns =
      tableName === 'relay_servers'
        ? 'server_id, status, hostname'
        : 'server_id, status, domain';

    const { data: servers, error } = await client
      .from(tableName)
      .select(columns)
      .eq('status', 'pending');

    if (error) {
      this.logger.error(`Supabase Error (${tableName}): ${error.message}`);
      return;
    }

    if (!servers || servers.length === 0) return;

    for (const server of servers) {
      const logName = (server as any).hostname || (server as any).domain;
      try {
        // 2. Get Linode status
        const linodeInstance = await this.service.getLinodeServer(
          server.server_id,
        );

        if (!linodeInstance) {
          this.logger.warn(
            `Server ${logName} in ${tableName} not found on Linode.`,
          );
          continue;
        }

        // 3. Update status if running
        if (linodeInstance.status === 'running') {
          const { error: updateError } = await client
            .from(tableName)
            .update({
              status: 'awaiting_manual_review',
            })
            .eq('server_id', server.server_id);

          if (updateError) {
            this.logger.error(
              `Failed to update ${logName} in ${tableName}: ${updateError.message}`,
            );
          } else {
            this.logger.log(`Server ${logName} (${tableName}) is now running.`);
          }
        }
      } catch (e) {
        this.logger.error(
          `Error syncing status for ${logName} in ${tableName}: ${e.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleReverseDnsConfiguration() {
    this.logger.log('Checking for relay servers needing Reverse DNS...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch servers where A-record is DONE, but rDNS is NOT DONE (null or false)
    const { data: servers, error } = await client
      .from('relay_servers')
      .select(
        'server_name, server_id, ipaddress, hostname, rdns_set, a_record_set, master_relay_servers(domain)',
      )
      .eq('status', 'awaiting_manual_review')
      .is('a_record_set', true)
      .or('rdns_set.is.null,rdns_set.eq.false');

    if (error) {
      this.logger.error(`Supabase Error: ${error.message}`);
      return;
    }

    if (!servers || servers.length === 0) return;

    for (const server of servers) {
      try {
        // Validation: We need the IP and the Hostname to set rDNS
        if (!server.ipaddress || !server.hostname) {
          this.logger.warn(
            `Skipping rDNS for ${server.server_name}: Missing IP or Hostname.`,
          );
          continue;
        }

        this.logger.log(
          `Configuring rDNS for ${server.ipaddress} -> ${server.hostname}`,
        );

        const masterServer = server.master_relay_servers;

        const masterServerDomain = Array.isArray(masterServer)
          ? masterServer[0]?.domain
          : (masterServer as any)?.domain;

        // 2. Call Linode Service to set the Reverse DNS (PTR Record)
        const response = await this.service.configureReverseDns(
          server.server_id,
          server.ipaddress,
          `${server.hostname}.${masterServerDomain}`,
        );

        if (response?.errors) {
          this.logger.error(
            `Linode rDNS Error for ${server.server_name}: ${JSON.stringify(response.errors)}`,
          );
          continue;
        }

        if (response) {
          // 3. Update DB upon success
          const { error: updateError } = await client
            .from('relay_servers')
            .update({ rdns_set: true })
            .eq('server_name', server.server_name);

          if (!updateError) {
            this.logger.log(
              `✅ Reverse DNS successfully set for ${server.hostname}`,
            );
          }
        }
      } catch (e) {
        this.logger.error(
          `Failed to process rDNS for ${server.server_name}: ${e.message}`,
        );
      }
    }
  }
}
