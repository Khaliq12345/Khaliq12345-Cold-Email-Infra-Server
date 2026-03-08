// domain.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SharedService } from 'src/shared/shared.service';
import * as dns from 'dns';

@Injectable()
export class DomainService {
  private readonly logger = new Logger(DomainService.name);

  constructor(private readonly service: SharedService) {}

  async addDomain(username: string, domain: string) {
    const supabase = this.service.SupabaseClient();

    // Call the RPC function we just created
    const { data, error } = await supabase.rpc(
      'assign_master_mail_server_to_domain',
      {
        p_username: username,
        p_domain: domain,
      },
    );

    if (error) {
      this.logger.error(`Failed to add domain via RPC: ${error.message}`);

      // Distinguish between business logic errors and server errors
      if (error.message.includes('No running mail servers')) {
        throw new BadRequestException(error.message);
      }

      throw new InternalServerErrorException(error.message);
    }

    this.logger.log(
      `Domain ${domain} successfully linked to server ${data.master_server}`,
    );
    return data;
  }

  async getDomainsByUser(
    username: string,
    page: number = 1,
    limit: number = 20,
    filters: {
      domain?: string;
      platform?: string;
      mailboxesCount?: number;
      order?: string;
      exportStatus?: string;
    } = {},
  ) {
    const client = this.service.SupabaseClient();

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // 1. Initialize the Base Query
    let query = client
      .from('domains')
      .select('*, mailboxes(count)', { count: 'exact' })
      .eq('username', username);

    // 2. Apply Filters

    // Filter by Domain (Partial match / Case-insensitive)
    if (filters.domain) {
      query = query.ilike('domain', `%${filters.domain}%`);
    }

    // Filter by PlusVibe Export Status
    if (filters.exportStatus !== undefined) {
      if (filters.exportStatus) {
        query = query.eq('plusvibe_sync_status', filters.exportStatus);
        // once you have more than one platform we start change .eq to .or (if you know what I mean)
      }
    }

    // Filter by PlusVibe Workspace (Is not null)
    if (filters.platform === 'plusvibe') {
      query = query.not('plusvibe_workspace', 'is', null);
    }

    if (filters.order == 'desc') {
      query = query.order('created_at', { ascending: false });
    } else {
      query = query.order('created_at', { ascending: true });
    }

    // 3. Apply Ordering and Range (Pagination)
    const { data, error, count } = await query.range(from, to);

    if (error) {
      this.logger.error(`Error fetching domains for user: ${error.message}`);
      throw error;
    }

    // 4. Map and Format Data
    let formattedData = data.map((item) => {
      const { mailboxes, ...domainData } = item;
      return {
        ...domainData,
        total_mailboxes: (mailboxes as any)?.[0]?.count || 0,
      };
    });

    // Apply the mailboxes filter after mapping
    const minCount = filters.mailboxesCount;

    if (minCount !== undefined && minCount !== null) {
      formattedData = formattedData.filter(
        (item) => item.total_mailboxes >= minCount,
      );
    }

    // 3. Return the cleaned object
    return {
      data: formattedData,
      total: count,
    };
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
    try {
      // it's more "forgiving" of DNS configuration errors
      await dns.promises.lookup(domain);
      return true;
    } catch (error) {
      // If lookup fails, try a direct NS (Nameserver) query
      // This catches domains that are registered but have no 'A' record (no website)
      try {
        const ns = await dns.promises.resolveNs(domain);
        return ns.length > 0;
      } catch (nsError) {
        // If we get ENOTFOUND, it's definitely available.
        // If we get ESERVFAIL, the domain exists but its DNS is broken.
        if (nsError.code === 'ENOTFOUND') return false;
        if (nsError.code === 'ESERVFAIL') return true; // Broken DNS usually means it's registered

        return false;
      }
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
