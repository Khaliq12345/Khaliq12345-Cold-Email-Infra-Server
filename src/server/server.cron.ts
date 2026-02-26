import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SharedService } from 'src/shared/shared.service';
import { ServerService } from './server.service';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

@Injectable()
export class ServerCronService {
  private readonly logger = new Logger(ServerCronService.name);

  constructor(
    private readonly sharedservice: SharedService,
    private readonly service: ServerService,
    @InjectQueue('dkim-provisioning') private dkimQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'matching-domains-to-servers' })
  async matchDomainsToServers() {
    this.logger.log(
      'Checking for verified domains needing server assignment...',
    );
    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch domains that are verified but not yet assigned to a relay_server
    const { data: domains, error } = await client
      .from('domains')
      .select('id, domain, username')
      .is('nameserver', true)
      .is('paid', true)
      .or(
        'is_dkim_configured_in_server.is.null,is_dkim_configured_in_server.eq.false',
      );

    if (error || !domains || domains.length === 0) return;

    for (const record of domains) {
      this.logger.log(`Domain - ${record.domain}`);
      try {
        // 2. Call the "Clash-Proof" SQL Function
        let { data: assignedServerName, error: rpcError } = await client.rpc(
          'assign_server_to_domain',
          {
            p_domain_name: record.domain,
            p_username: record.username,
          },
        );

        if (rpcError) throw new Error(rpcError.message);

        if (assignedServerName) {
          this.logger.log(
            `✅ [MATCHED] ${record.domain} -> ${assignedServerName}`,
          );

          // 3. TRIGGER ANSIBLE: Now that the DB is updated, run the DKIM setup
          this.logger.log(`📥 Queuing DKIM setup for ${record.domain}`);

          // Add to queue
          await this.dkimQueue.add(
            'setup-job',
            {
              domainName: record.domain,
              serverName: assignedServerName,
            },
            {
              attempts: 3, // Retry if SSH fails
              backoff: 5000, // Wait 5s between retries
            },
          );
        } else {
          // 4. TRIGGER CREATION: No capacity found in existing/fresh servers
          this.logger.warn(
            `⚠️ [POOL EMPTY] No capacity for ${record.domain}. Scale the infrastructure...`,
          );
          // const { data, error } = await client
          //   .from('master_relay_servers')
          //   .select('*')
          //   .eq('status', 'running')
          //   .single();
          //
          // if (error || !data) {
          //   this.logger.error(
          //     'Error getting the master relay or no active master found',
          //   );
          //   throw error || new Error('No active master relay configuration');
          // }
          //
          // const { data: nextId, error: seqError } =
          //   await client.rpc('get_next_relay_id');
          //
          // if (seqError) throw seqError;
          //
          // // 2. Format the short, clean label
          // const uniqueLabel = `relay-${nextId}`;
          //
          // // Logic to trigger the new Linode creation since the DB function returned NULL
          // await this.service.createLinode(
          //   uniqueLabel,
          //   data.domain,
          //   data.ip_address,
          // );
          // this.logger.log(`Provisioning started for new relay server`);
        }
      } catch (e) {
        this.logger.error(`Failed to process ${record.domain}: ${e.message}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'sync-server-status',
  })
  async syncServerStatuses() {
    this.logger.log('Syncing server statuses with Linode...');

    // 1. Fetch servers from DB that are NOT yet marked as 'running'

    const client = this.sharedservice.SupabaseClient();
    const { data: servers, error } = await client
      .from('relay_servers')
      .select('server_name, status, hostname')
      .eq('status', 'pending');

    // 1. Check if there is an error code
    if (error) {
      this.logger.error(
        `Supabase Error: ${error.message} (Code: ${error.code})`,
      );
      return;
    }

    for (const server of servers) {
      try {
        // 2. Call your function to get the latest data from Linode
        const linodeInstance = await this.service.getLinodeServer(
          server.server_name,
        );

        if (!linodeInstance) {
          this.logger.warn(`Server ${server.hostname} not found on Linode.`);
          continue;
        }

        // 3. Check if Linode says it's running
        // Note: Linode API status is usually lowercase 'running'
        if (linodeInstance.status === 'running') {
          await client
            .from('relay_servers')
            .update({
              status: 'awaiting_manual_review',
            })
            .eq('server_name', server.server_name);

          this.logger.log(
            `Server ${server.hostname} is now active and running.`,
          );
        }
      } catch (e) {
        this.logger.error(
          `Error syncing status for ${server.hostname}: ${e.message}`,
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleReverseDnsConfiguration() {
    this.logger.log('Checking for relay servers needing Reverse DNS...');

    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch servers where A-record is DONE, but rDNS is NOT DONE (null or false)
    const { data: servers, error } = await client
      .from('relay_servers')
      .select(
        'server_name, server_id, ipaddress, hostname, rdns_set, a_record_set, master_relay_servers(domain)',
      )
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
