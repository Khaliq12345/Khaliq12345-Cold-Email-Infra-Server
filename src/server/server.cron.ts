import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SharedService } from 'src/shared/shared.service';
import { ServerService } from './server.service';

@Injectable()
export class ServerCronService {
  private readonly logger = new Logger(ServerCronService.name);

  constructor(
    private readonly sharedservice: SharedService,
    private readonly service: ServerService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'creating-servers',
  })
  async provisionPendingServers() {
    this.logger.log('Checking for verified domains needing servers...');

    const client = this.sharedservice.SupabaseClient();
    const { data: domains, error } = await client
      .from('domains')
      .select('id, domain, username, relay_servers(server_name)')
      .is('nameserver', true);

    if (error || !domains) return;

    // 2. Filter domains that don't have a linked server record
    const unprovisioned = domains.filter(
      (d) => !d.relay_servers || d.relay_servers.length === 0,
    );

    if (unprovisioned.length === 0) {
      this.logger.debug('No new servers to provision.');
      return;
    }

    for (const record of unprovisioned) {
      try {
        this.logger.log(`Provisioning server for ${record.domain}...`);

        // 3. Call your existing server function
        const { data: MasterRelayServers, error } = await client
          .from('master_relay_servers')
          .select('id, domain, ip_address, status, master_mail_servers(id)')
          .eq('status', 'running');

        if (
          error ||
          !MasterRelayServers ||
          !MasterRelayServers[0].master_mail_servers
        ) {
          this.logger.warn('No relay server or mail server to use');
          return;
        }

        const masterRelayServer = MasterRelayServers[0];
        const masterMailServerId = (
          masterRelayServer.master_mail_servers as any
        ).id;
        const relayHostName = `relay-${record.id}`;
        const relayDomain = masterRelayServer.domain;
        const mailDomain = record.domain;
        const parentRelayIp = masterRelayServer.ip_address;
        const response = await this.service.createLinode(
          relayHostName,
          relayDomain,
          mailDomain,
          parentRelayIp,
        );

        // 4. Record the creation in the 'servers' table to prevent duplicates
        const { data: creationData, error: creationError } = await client
          .from('relay_servers')
          .insert([
            {
              server_name: `ubuntu-${relayHostName}`,
              server_id: response.id,
              ipaddress: response.ipv4[0], // assuming your function returns this
              status: 'pending',
              hostname: relayHostName,
              master_mail_server: masterMailServerId,
              master_relay_server: masterRelayServer.id,
              domain: record.domain,
            },
          ]);

        if (creationError) {
          this.logger.error(
            `Error updating supabase - ${creationError.message}`,
          );
          return;
        }

        this.logger.log(`Successfully created server for ${record.domain}`);
      } catch (e) {
        this.logger.error(`Failed to provision ${record.domain}: ${e.message}`);
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
              status: 'running',
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
