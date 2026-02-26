import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import * as dns from 'dns';
import { SharedService } from 'src/shared/shared.service';
import { promisify } from 'util';

const resolveNs = promisify(dns.resolveNs);

@Injectable()
export class DomainCronService {
  private readonly logger = new Logger(DomainCronService.name);

  // The required Hetzner nameservers
  private readonly REQUIRED_NS = [
    'ns1.linode.com',
    'ns2.linode.com',
    'ns3.linode.com',
    'ns4.linode.com',
    'ns5.linode.com',
  ];

  constructor(private readonly service: SharedService) {}

  @Cron(CronExpression.EVERY_MINUTE, {
    name: 'verify-domain-nameservers',
  })
  async handleNameserverPolling() {
    this.logger.log('Starting Nameserver polling cycle via RDAP...');

    const client = this.service.SupabaseClient();

    // 1. Fetch domains that haven't been verified yet
    const { data: domains, error } = await client
      .from('domains')
      .select('id, domain')
      .or('nameserver.is.null,nameserver.eq.false')
      .is('paid', true);

    if (error || !domains) {
      if (error) this.logger.error(`Supabase Error: ${error.message}`);
      return;
    }

    // 2. Check each domain via RDAP
    for (const record of domains) {
      try {
        // rdap.org acts as a bootstrap to find the correct TLD registry
        const url = `https://rdap.org/domain/${record.domain.toLowerCase()}`;
        const response = await axios.get(url, { timeout: 5000 });

        const rdapNameservers = response.data?.nameservers || [];

        // Extract the ldhName (host name) from the RDAP response
        const resolvedNs: string[] = rdapNameservers.map((ns: any) =>
          ns.ldhName.toLowerCase(),
        );

        // 3. Check if ANY of the RDAP nameservers match our REQUIRED_NS
        const isMatch = resolvedNs.some((ns) => this.REQUIRED_NS.includes(ns));

        if (isMatch) {
          const { error: updateError } = await client
            .from('domains')
            .update({ nameserver: true })
            .eq('id', record.id);

          if (updateError) {
            this.logger.error(
              `Update failed for ${record.domain}: ${updateError.message}`,
            );
          } else {
            this.logger.log(`Domain ${record.domain} verified via RDAP!`);
          }
        } else {
          this.logger.debug(
            `Domain ${record.domain} is not yet pointing to Hetzner.`,
          );
        }
      } catch (e) {
        // 404 means the domain isn't registered; other codes might be rate limits
        if (e.response?.status === 404) {
          this.logger.warn(
            `Domain ${record.domain} not found in RDAP registry.`,
          );
        } else {
          this.logger.error(
            `RDAP lookup failed for ${record.domain}: ${e.message}`,
          );
        }
      }
    }
  }
}
