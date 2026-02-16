import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as dns from 'dns';
import { SharedService } from 'src/shared/shared.service';
import { promisify } from 'util';

const resolveNs = promisify(dns.resolveNs);

@Injectable()
export class DomainCronService {
  private readonly logger = new Logger(DomainCronService.name);
  // The required Hetzner nameservers
  private readonly REQUIRED_NS = [
    'hydrogen.ns.hetzner.com',
    'helium.ns.hetzner.de',
    'oxygen.ns.hetzner.com',
  ];

  constructor(private readonly service: SharedService) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'verify-domain-nameservers',
  })
  async handleNameserverPolling() {
    this.logger.log('Starting Nameserver polling cycle...');

    // 1. Fetch domains that haven't been verified yet
    const client = this.service.SupabaseClient();
    const { data: domains, error } = await client
      .from('domains')
      .select('id, domain')
      .or('nameserver.is.null,nameserver.eq.false');

    if (error || !domains) {
      this.logger.error(error);
      return;
    }

    // 2. Check each domain
    for (const record of domains) {
      try {
        const resolvedNs = await resolveNs(record.domain);

        // 2. Check if ANY of the resolved NS match ANY of our required NS
        const isMatch = resolvedNs.some((ns) =>
          this.REQUIRED_NS.includes(ns.toLowerCase()),
        );

        if (isMatch) {
          // 3. Update DB if it matches
          await client
            .from('domains')
            .update({ nameserver: true })
            .eq('id', record.id);

          this.logger.log(`Domain ${record.domain} verified!`);
        }
      } catch (e) {
        // Domain might not be registered or DNS hasn't propagated
        this.logger.error(`Could not resolve NS for ${record.domain}`);
      }
    }
  }
}
