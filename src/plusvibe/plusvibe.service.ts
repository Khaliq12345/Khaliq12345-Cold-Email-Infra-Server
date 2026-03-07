// plusvibe.service.ts
import {
  Injectable,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { SharedService } from 'src/shared/shared.service';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';

@Injectable()
export class PlusvibeService {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly logger = new Logger(PlusvibeService.name);

  constructor(
    private readonly sharedService: SharedService,
    private configService: ConfigService,
    @InjectQueue('plusvibe-cron') private queueService: Queue,
  ) {
    this.apiBaseUrl = this.configService.get('PLUSVIBE_BASE_URL') as string;
    this.apiKey = this.configService.get('PLUSVIBE_API_KEY') as string;
  }

  async updatePlusVibeApiKey(username: string, apiKey: string) {
    this.logger.log(`Updating global PlusVibe API key for user: ${username}`);

    // Using .update() instead of .upsert() to protect other columns
    const { data, error } = await this.sharedService
      .SupabaseClient()
      .from('users')
      .update({ plusvibe_apikey: apiKey })
      .eq('username', username) // Only target this specific user
      .select();

    if (error) {
      this.logger.error(`Failed to update user API key: ${error.message}`);
      throw new InternalServerErrorException('Could not save user API key');
    }

    // Check if the user actually exists
    if (!data || data.length === 0) {
      this.logger.warn(
        `Attempted to update API key for non-existent user: ${username}`,
      );
      throw new NotFoundException(`User ${username} not found.`);
    }

    return { message: 'User API key updated successfully', status: 'success' };
  }

  async linkWorkspaceToDomain(domain: string, workspaceId: string) {
    this.logger.log(
      `Linking domain ${domain} to PlusVibe workspace: ${workspaceId}`,
    );

    const { data, error } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .update({ plusvibe_workspace: workspaceId })
      .eq('domain', domain)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to link workspace: ${error.message}`);
      throw new InternalServerErrorException(
        'Could not link workspace to domain',
      );
    }

    return {
      success: true,
      domain: data.domain,
      workspaceId: data.plusvibe_workspace,
    };
  }

  async getPlusVibeCredentials(domain?: string, username?: string) {
    // 1. If we have a domain, we do the Join to get both Workspace (Domain) and Key (User)
    if (domain) {
      this.logger.log('getting credentials via domain');
      const { data, error } = await this.sharedService
        .SupabaseClient()
        .from('domains')
        .select(
          `
          plusvibe_workspace,
          users!inner ( plusvibe_apikey )
        `,
        )
        .eq('domain', domain)
        .single();

      const user = data?.users as any;
      if (error || !user.plusvibe_apikey) {
        this.logger.error(`PlusVibe config missing for domain ${domain}`);
        throw new NotFoundException(
          'PlusVibe configuration incomplete for this domain',
        );
      }

      return {
        apiKey: user.plusvibe_apikey,
        workspaceId: data.plusvibe_workspace,
      };
    }

    // 2. If we only have a username, we just get the API Key (useful for fetching workspace lists)
    if (username) {
      this.logger.log('getting credentials via domain');
      const { data, error } = await this.sharedService
        .SupabaseClient()
        .from('users')
        .select('plusvibe_apikey')
        .eq('username', username)
        .single();

      if (error || !data?.plusvibe_apikey) {
        throw new NotFoundException('PlusVibe API key not found for this user');
      }

      return {
        apiKey: data.plusvibe_apikey,
        workspaceId: null, // No domain provided, so no specific workspace
      };
    }

    throw new BadRequestException('Either domain or username must be provided');
  }

  async getWorkspaces(username: string): Promise<Object[]> {
    this.logger.log('Retrieving the workspaces');

    const apiKey = (await this.getPlusVibeCredentials(undefined, username))
      .apiKey;
    try {
      const { data } = await axios.get(`${this.apiBaseUrl}/authenticate`, {
        headers: { 'x-api-key': apiKey },
      });
      return data;
    } catch (error) {
      this.logger.error(`PlusVibe Error getting the workspaces - ${error}`);
      throw new HttpException(
        error.response?.data || 'Failed to get workspaces',
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async sendMailboxesToWorkspace(
    domain: string,
    mailserverHost: string,
    username: string,
    workspaceId: string,
  ) {
    const { data, error } = await this.sharedService
      .SupabaseClient()
      .from('mailboxes')
      .select('*')
      .eq('domain', domain)
      .is('is_active', true)
      .or('added_to_plusvibe.eq.false,added_to_plusvibe.is.null');

    if (error) {
      this.logger.log('Error fetching from Supabase:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      this.logger.log(
        `No pending Mailbox Accounts found for domain: ${domain}`,
      );
      return;
    }

    // 1. Prepare the accounts array
    const accountsToProcess = data.map((record) => ({
      first_name: record.first_name,
      last_name: record.last_name,
      email: record.email,
      username: record.username,
      password: record.password,
      imap_host: mailserverHost,
      imap_port: Number(record.imap_port),
      smtp_host: mailserverHost,
      smtp_username: record.email,
      smtp_password: record.password,
      smtp_port: Number(record.smtp_port),
      // Campaign Settings
      daily_limit: 3,
      min_interval: 60, // Recommended default interval
      enable_camp_rampup: 'yes',
      camp_rampup_start: 1,
      camp_rampup_increment: 1,

      // Warmup Settings
      enable_warmup: 'yes',
      warmup_daily_limit: 5, // Based on your daily limit requirement
      enable_warmup_rampup: 'yes',
      warmup_rampup_start: 1,
      warmup_rampup_increment: 1,
    }));

    // 2. Execute Bulk Add
    this.logger.log(
      `Sending ${accountsToProcess.length} accounts to PlusVibe API`,
    );

    const credential = await this.getPlusVibeCredentials(domain, username);
    const instance = axios.create({
      baseURL: this.apiBaseUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': credential.apiKey,
      },
    });
    await instance.post('/account/bulk-add-regular-accounts', {
      workspace_id: workspaceId,
      accounts: accountsToProcess,
    });

    this.logger.log('Bulk add SMTP accounts request successful');

    // 3. Success! Update Supabase in bulk
    this.logger.log('UPDATING SUPABASE RECORDS STATUS');

    const accountEmails = data.map((record) => record.email);

    const { error: updateError } = await this.sharedService
      .SupabaseClient()
      .from('mailboxes')
      .update({ added_to_plusvibe: true, status: 'warming' })
      .in('email', accountEmails);

    if (updateError) {
      console.log('Error updating Supabase status:', updateError);
    }
  }

  async listPlusvibeMailboxes(workspaceId: string, username: string) {
    try {
      this.logger.log(`Listing email accounts for workspace: ${workspaceId}`);

      const params: any = {
        workspace_id: workspaceId,
      };

      const credential = await this.getPlusVibeCredentials(undefined, username);
      const instance = axios.create({
        baseURL: this.apiBaseUrl,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': credential.apiKey,
        },
      });
      const response = await instance.get('/account/list', {
        params: params,
      });
      return response.data.accounts;
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message;
      this.logger.error(`PlusVibe List Email Accounts Error: ${errorMessage}`);
      throw error;
    }
  }

  async queueSendMailboxesToWorkspace(
    requestedDomains: string[],
    workspaceId: string,
  ) {
    // 1. Fetch from Supabase with filters
    const { data: matchedDomains, error } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .select('domain, username, master_mail_servers(domain)')
      .in('domain', requestedDomains)
      .is('paid', true)
      .is('is_dkim_configured_in_server', true)
      .is('is_dkim_set', true)
      .is('is_mapped_to_relay', true);

    if (error) {
      this.logger.error(`Supabase error: ${error.message}`);
      throw new InternalServerErrorException('Database query failed');
    }

    if (!matchedDomains || matchedDomains.length === 0) {
      this.logger.log('No domains met the sync criteria.');
      return { success: false, matchedCount: 0 };
    }

    // 2. Map and Add to Queue
    await this.queueService.add(
      'add-mailboxes-to-workspace',
      {
        domains: matchedDomains.map((d) => ({
          domain: d.domain,
          username: d.username,
          master_mail_servers: (d.master_mail_servers as any)?.domain,
        })),
        workspaceId: workspaceId,
      },
      {
        attempts: 3,
        backoff: 5000,
        removeOnComplete: true,
      },
    );

    this.logger.log(`Queued ${matchedDomains.length} domains for sync.`);

    return {
      success: true,
      matchedCount: matchedDomains.length,
      providedCount: requestedDomains.length,
    };
  }
}
