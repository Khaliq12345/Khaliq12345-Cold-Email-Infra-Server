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
        'server_name, domain, ipaddress, a_record_set, hostname, master_relay_server(domain)',
      )
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
          `Setting A-record for ${server.domain} -> ${server.ipaddress}`,
        );

        // 2. Call your existing A-Record function
        const response = await this.service.addArecord(
          (server.master_relay_server as any).domain,
          server.hostname,
          server.ipaddress,
        );
        if (response?.errors) {
          this.logger.error(
            `Failed to set A-record for ${server.domain}: ${response}`,
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
          `Failed to set A-record for ${server.domain}: ${e.message}`,
        );
      }
    }
  }
}
