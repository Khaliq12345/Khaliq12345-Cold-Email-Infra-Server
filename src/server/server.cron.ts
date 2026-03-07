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
    @InjectQueue('servers-cron') private queueService: Queue,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'map-domain-to-relay-server-via-master-server',
  })
  async MapParentServer() {
    this.logger.log(
      'Checking for verified domains needing mapping assignment...',
    );
    const client = this.sharedservice.SupabaseClient();

    // 1. Fetch domains where DKIM is not yet configured, ensuring we join relay info
    const { data: domains, error } = await client
      .from('domains')
      .select(
        `
        id, 
        domain, 
        relay_servers (
          ipaddress,
          master_relay_servers (
            ip_address
          )
        )
      `,
      )
      .is('paid', true)
      .not('relay_server', 'is', null)
      .is('is_mapped_to_relay', false);

    if (error) {
      this.logger.error(`Error fetching domains: ${error.message}`);
      return;
    }

    if (!domains || domains.length === 0) return;

    for (const record of domains) {
      try {
        // 1. Handle potential array or object for relay_servers
        const relayServer = Array.isArray(record.relay_servers)
          ? record.relay_servers[0]
          : record.relay_servers;

        // 2. Handle potential array or object for master_relay_servers
        const masterRelayServer = Array.isArray(
          relayServer?.master_relay_servers,
        )
          ? relayServer.master_relay_servers[0]
          : relayServer?.master_relay_servers;

        const childRelayIp = relayServer?.ipaddress;
        const masterRelayIp = masterRelayServer?.ip_address;
        this.logger.log(
          `Relay Server IP: ${childRelayIp ?? 'NULL'}, ` +
            `Master Relay IP: ${masterRelayIp ?? 'NULL'}`,
        );

        // 3. Validation with detailed logging
        if (!childRelayIp || !masterRelayIp) {
          this.logger.error(
            `Skipping ${record.domain}: Missing IP info. ` +
              `Relay Server IP: ${childRelayIp ?? 'NULL'}, ` +
              `Master Relay IP: ${masterRelayIp ?? 'NULL'}`,
          );
          continue;
        }

        // 3. TRIGGER ANSIBLE: Now that the DB is updated, run the Domain mapping
        this.logger.log(`📥 Queuing Domain mapping for ${record.domain}`);

        // Add to queue
        await this.queueService.add(
          'map-domain-to-server',
          {
            masterRelayIp: masterRelayIp,
            domainName: record.domain,
            childRelayIp: childRelayIp,
          },
          {
            attempts: 3, // Retry if SSH fails
            backoff: 5000, // Wait 5s between retries
          },
        );
        break;
      } catch (err) {
        this.logger.error(
          `❌ Failed to process domain ${record.domain}: ${err.message}`,
        );
      }
    }
  }

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
          await this.queueService.add(
            'setup-dkim',
            {
              domainName: record.domain,
              serverName: assignedServerName,
            },
            {
              attempts: 3, // Retry if SSH fails
              backoff: 5000, // Wait 5s between retries
            },
          );
          break;
        } else {
          // 4. TRIGGER CREATION: No capacity found in existing/fresh servers
          this.logger.warn(
            `⚠️ [POOL EMPTY] No capacity for ${record.domain}. Scale the infrastructure...`,
          );
        }
      } catch (e) {
        this.logger.error(`Failed to process ${record.domain}: ${e.message}`);
      }
    }
  }
}
