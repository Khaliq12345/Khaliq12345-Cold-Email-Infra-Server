// domain.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SharedService } from 'src/shared/shared.service';
import { promisify } from 'util';
import * as whois from 'whois';

@Injectable()
export class DomainService {
  private readonly logger = new Logger(DomainService.name);
  // Convert callback-based whois.lookup to a Promise-based function
  private lookupPromise = promisify(whois.lookup);

  constructor(private readonly service: SharedService) {}

  async addDomain(username: string, domain: string) {
    const supabase = this.service.SupabaseClient();

    // 0. Fetch all servers currently marked as 'running'
    const { data: masterServers, error: masterErrors } = await supabase
      .from('master_mail_servers')
      .select('domain, status, id')
      .eq('status', 'running');

    if (masterErrors) {
      this.logger.error(
        `Failed to fetch master servers: ${masterErrors.message}`,
      );
      throw new InternalServerErrorException(masterErrors.message);
    }

    if (!masterServers || masterServers.length === 0) {
      throw new BadRequestException('No running mail servers available.');
    }

    let selectedServerDomainId = null;
    let currentCount = 0;

    // 1. Loop through servers to find the first one with space
    for (const server of masterServers) {
      const { count, error: countError } = await supabase
        .from('domains')
        .select('*', { count: 'exact', head: true })
        .eq('master_mail_server', server.id);

      if (countError || count === null || count === undefined) continue;

      if (count < 10) {
        selectedServerDomainId = server.id;
        currentCount = count;
        break; // Found an available server, exit loop
      } else {
        // 2. Self-healing: If we find a server at 10 but status is still 'running', update it to 'filled'
        await supabase
          .from('master_mail_servers')
          .update({ status: 'filled' })
          .eq('domain', server.domain);
      }
    }

    if (!selectedServerDomainId) {
      throw new BadRequestException(
        'All running servers are currently filled (10/10 domains).',
      );
    }

    // 3. Insert the new domain into the selected server
    const { data, error: insertError } = await supabase
      .from('domains')
      .insert([
        {
          username,
          domain,
          master_mail_server: selectedServerDomainId,
        },
      ])
      .select()
      .single();

    if (insertError) {
      throw new InternalServerErrorException(insertError.message);
    }

    // 4. Final check: If this was the 10th domain, update server status to 'filled'
    if (currentCount + 1 === 10) {
      await supabase
        .from('master_mail_servers')
        .update({ status: 'filled' })
        .eq('id', selectedServerDomainId);

      this.logger.log(`Master server is now marked as filled.`);
    }

    return { ...data, master_server: selectedServerDomainId };
  }

  async getDomainsByUser(username: string) {
    const client = this.service.SupabaseClient();

    const { data, error } = await client
      .from('domains')
      .select('*')
      .eq('username', username);

    if (error) {
      this.logger.error(`Error fetching domains for user: ${error.message}`);
      throw error;
    }

    return data;
  }

  async getDomainDetails(domain: string) {
    const client = this.service.SupabaseClient();

    const { data, error } = await client
      .from('domains')
      .select('*')
      .eq('domain', domain)
      .maybeSingle();

    if (error) {
      this.logger.error(
        `Database error fetching domain ${domain}: ${error.message}`,
      );
      throw new InternalServerErrorException('Database query failed');
    }

    if (!data) {
      this.logger.warn(`Domain lookup failed: ${domain} does not exist`);
      throw new NotFoundException(`Domain '${domain}' not found`);
    }

    return data;
  }

  async isDomainRegistered(domain: string): Promise<boolean> {
    this.logger.log(`Performing WHOIS lookup for: ${domain}`);

    try {
      const data: any = await this.lookupPromise(domain);

      const notFoundExpressions = [
        'No match for',
        'NOT FOUND',
        'Not Registered',
        'No Data Found',
        'available for purchase',
      ];

      const isNotFound = notFoundExpressions.some((expression) =>
        data.toLowerCase().includes(expression.toLowerCase()),
      );

      // If we DID NOT find "Not Found" messages, the domain is taken.
      const isRegistered = !isNotFound;

      this.logger.debug(
        `WHOIS result for ${domain}: ${isRegistered ? 'TAKEN' : 'AVAILABLE'}`,
      );
      return isRegistered;
    } catch (error) {
      this.logger.error(`WHOIS Error for ${domain}: ${error.message}`);
      // If WHOIS fails (e.g., rate limited), we might want to fallback or throw
      throw new InternalServerErrorException(
        'Could not verify domain availability',
      );
    }
  }

  async getDomainStatsByUser(username: string) {
    this.logger.log(`Fetching all domain stats for user: ${username}`);

    try {
      const { data, error } = await this.service
        .SupabaseClient()
        .from('domain_mailbox_counts')
        .select('*')
        .eq('username', username)
        .order('domain', { ascending: true });

      if (error) {
        this.logger.error(
          `Database Error fetching view for ${username}: ${error.message}`,
        );
        throw error;
      }

      // Calculate totals from the retrieved data
      const total_domains = data?.length || 0;
      const total_mailboxes =
        data?.reduce((acc, curr) => acc + (Number(curr.total_count) || 0), 0) ||
        0;

      this.logger.log(
        `Retrieved ${total_domains} domains and ${total_mailboxes} total mailboxes for ${username}`,
      );

      return {
        stats: data, // The original list for your chart
        total_domains, // Count of unique domain rows
        total_mailboxes, // Sum of all total_count values
      };
    } catch (error) {
      this.logger.error(`Failed to get domain stats: ${error.message}`);
      throw new InternalServerErrorException(
        'Could not retrieve domain mailbox statistics',
      );
    }
  }
}
