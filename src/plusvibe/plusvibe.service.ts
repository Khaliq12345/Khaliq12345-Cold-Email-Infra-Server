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
  private readonly logger = new Logger(PlusvibeService.name);
  private getPlusVibeClient(apiKey: string) {
    return axios.create({
      baseURL: this.apiBaseUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    });
  }
  constructor(
    private readonly sharedService: SharedService,
    private configService: ConfigService,
    @InjectQueue('plusvibe-cron') private queueService: Queue,
  ) {
    this.apiBaseUrl = this.configService.get('PLUSVIBE_BASE_URL') as string;
  }

  async updateDomainSyncStatus(
    domain: string,
    status: 'IDLE' | 'SENDING' | 'VERIFYING',
  ) {
    await this.sharedService
      .SupabaseClient()
      .from('domains')
      .update({ plusvibe_sync_status: status })
      .eq('domain', domain);
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

  async getPlusVibeCredentials(username: string) {
    // 1. If we have a domain, we do the Join to get both Workspace (Domain) and Key (User)
    this.logger.log('getting plusvibe apikey');
    const { data, error } = await this.sharedService
      .SupabaseClient()
      .from('users')
      .select(
        `
          plusvibe_apikey
        `,
      )
      .eq('username', username)
      .single();

    const apikey = data?.plusvibe_apikey as any;
    if (error || !apikey) {
      this.logger.error(`PlusVibe apikey missing for user`);
      throw new NotFoundException(
        'PlusVibe configuration incomplete for this domain',
      );
    }

    return {
      apiKey: apikey,
    };
  }

  async getWorkspaces(username: string): Promise<Object[]> {
    this.logger.log('Retrieving the workspaces');

    const { apiKey } = await this.getPlusVibeCredentials(username);
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
    // 0. Fetch mailboxes that aren't confirmed yet
    const { data: pendingMailboxes, error } = await this.sharedService
      .SupabaseClient()
      .from('mailboxes')
      .select('*')
      .eq('domain', domain)
      .or('added_to_plusvibe.eq.false,added_to_plusvibe.is.null');

    if (error || !pendingMailboxes?.length) return;

    const { apiKey } = await this.getPlusVibeCredentials(username);
    const client = this.getPlusVibeClient(apiKey);

    // 1. Update domain workspace_id and set status to SENDING
    const { error: plusvibeUpdateError } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .update({
        plusvibe_workspace: workspaceId,
        plusvibe_sync_status: 'SENDING',
      })
      .eq('domain', domain);

    // Handle database update errors
    if (plusvibeUpdateError) {
      this.logger.error(
        `Failed to initialize domain sync state: ${plusvibeUpdateError.message}`,
      );
      throw new Error(`DB Update failed for ${domain}`);
    }

    // 2. Map only the ones that aren't already in PlusVibe (Pre-check)
    const accountsToBulkAdd: any[] = [];
    this.logger.log('Pre-checking mailboxes to avoid duplicates');
    for (const mailbox of pendingMailboxes) {
      const checkRes = await client.get('/account/list', {
        params: { workspace_id: workspaceId, email: mailbox.email },
      });

      if (checkRes.data?.accounts?.length === 0) {
        accountsToBulkAdd.push({
          first_name: mailbox.first_name,
          last_name: mailbox.last_name,
          email: mailbox.email,
          username: mailbox.username,
          password: mailbox.password,
          imap_host: mailserverHost,
          imap_port: Number(mailbox.imap_port),
          smtp_host: mailserverHost,
          smtp_username: mailbox.email,
          smtp_password: mailbox.password,
          smtp_port: Number(mailbox.smtp_port),
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
        });
      }
    }

    if (accountsToBulkAdd.length === 0) {
      this.logger.log(`All accounts for ${domain} already requested or exist.`);
      return;
    }

    // 3. Just send the request and log it.
    try {
      await client.post('/account/bulk-add-regular-accounts', {
        workspace_id: workspaceId,
        accounts: accountsToBulkAdd,
      });
      this.logger.log(
        `Bulk add request accepted for ${accountsToBulkAdd.length} accounts.`,
      );
    } catch (err) {
      this.logger.error(`PlusVibe API accepted request failed: ${err.message}`);
    }
  }

  async syncWorkspaceMailboxes(
    username: string,
    workspaceId: string,
    domain: string,
  ) {
    const { apiKey } = await this.getPlusVibeCredentials(username);
    const client = this.getPlusVibeClient(apiKey);

    const remoteEmails = new Set<string>();
    let skip = 0;
    const limit = 100;

    this.logger.log(`Syncing truth from PlusVibe for domain: ${domain}`);

    // 1. Pagination Loop: Fetch the "Source of Truth"
    try {
      while (true) {
        const res = await client.get('/account/list', {
          params: { workspace_id: workspaceId, skip, limit },
        });

        const accounts = res.data?.accounts || [];
        accounts.forEach((acc: any) =>
          remoteEmails.add(acc.email.toLowerCase()),
        );

        if (accounts.length < limit) break;
        skip += limit;
      }
    } catch (err) {
      this.logger.error(
        `Failed to fetch PlusVibe account list: ${err.message}`,
      );
      throw err;
    }

    // 2. Database Reconciliation
    // Get ALL mailboxes for this domain to compare total counts
    this.logger.log(
      `Performing database reconciliation for this ${domain}'s mailboxes`,
    );
    const { data: allLocalMailboxes, error } = await this.sharedService
      .SupabaseClient()
      .from('mailboxes')
      .select('email, added_to_plusvibe')
      .eq('domain', domain);

    if (error || !allLocalMailboxes?.length) return 0;

    // Identify which ones are now in PlusVibe but marked 'false' locally
    const emailsToMarkSynced = allLocalMailboxes
      .filter(
        (m) => !m.added_to_plusvibe && remoteEmails.has(m.email.toLowerCase()),
      )
      .map((m) => m.email);

    // 3. Update Supabase for confirmed mailboxes
    if (emailsToMarkSynced.length > 0) {
      await this.sharedService
        .SupabaseClient()
        .from('mailboxes')
        .update({ added_to_plusvibe: true })
        .in('email', emailsToMarkSynced);

      this.logger.log(
        `Verified ${emailsToMarkSynced.length} new mailboxes for ${domain}.`,
      );
    }

    // 4. Final State Check: Are we finished?
    const totalInDb = allLocalMailboxes.length;
    const totalInPlusVibe = allLocalMailboxes.filter(
      (m) => m.added_to_plusvibe || remoteEmails.has(m.email.toLowerCase()),
    ).length;

    if (totalInPlusVibe === totalInDb) {
      this.logger.log(
        `Success: All ${totalInDb} mailboxes verified for ${domain}. Unlocking domain.`,
      );
      await this.updateDomainSyncStatus(domain, 'IDLE');
    } else {
      this.logger.warn(
        `Sync partial: ${totalInPlusVibe}/${totalInDb} found for ${domain}. Staying in VERIFYING state.`,
      );
    }

    return totalInPlusVibe; // Return current count so the Cron/Worker knows progress
  }

  async listPlusvibeMailboxes(workspaceId: string, username: string) {
    try {
      this.logger.log(`Listing email accounts for workspace: ${workspaceId}`);

      const params: any = {
        workspace_id: workspaceId,
      };

      const credential = await this.getPlusVibeCredentials(username);
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
    const { data: matchedDomains, error } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .select('domain, username, master_mail_servers(domain)')
      .in('domain', requestedDomains)
      .is('paid', true)
      .is('is_dkim_configured_in_server', true)
      .is('is_dkim_set', true)
      .is('is_mapped_to_relay', true)
      .or('plusvibe_sync_status.eq.IDLE,plusvibe_sync_status.is.null');

    if (error) throw new InternalServerErrorException('Database query failed');
    if (!matchedDomains?.length) return { success: false, matchedCount: 0 };

    // ADD EACH DOMAIN AS AN INDIVIDUAL JOB
    const jobPromises = matchedDomains.map((d) => {
      return this.queueService.add(
        'add-domain-mailboxes-to-plusvibe', // Specific name for the single domain task
        {
          domain: d.domain,
          username: d.username,
          // Ensure we extract the domain string correctly from the relation
          mailserverHost: (d.master_mail_servers as any)?.domain,
          workspaceId: workspaceId,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: true,
          // jobId: `adding-${d.domain}-mailboxes`,
        },
      );
    });

    await Promise.all(jobPromises);

    return { success: true, matchedCount: matchedDomains.length };
  }
}
