// plusvibe.service.ts
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import process from 'process';
import axios from 'axios';
import { SharedService } from 'src/shared/shared.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PlusvibeService {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly sharedService: SharedService,
    private configService: ConfigService,
  ) {
    this.apiBaseUrl = this.configService.get('PLUSVIBE_BASE_URL') as string;
    this.apiKey = this.configService.get('PLUSVIBE_API_KEY') as string;
  }

  async getWorkspaces(): Promise<Object[]> {
    try {
      const { data } = await axios.get(`${this.apiBaseUrl}/authenticate`, {
        headers: { 'x-api-key': this.apiKey },
      });
      console.log(data);
      return data;
    } catch (error) {
      console.log('BASE URL ', process.env);
      throw new HttpException(
        error.response?.data || 'Failed to get workspaces',
        error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async sendMailboxesToWorkspace(
    domain: string,
    workspaceId: string,
    mailserverHost: string,
  ) {
    const { data, error } = await this.sharedService
      .SupabaseClient()
      .from('mailboxes')
      .select('*')
      .eq('domain', domain)
      .is('is_active', true)
      .or('added_to_plusvibe.eq.false,added_to_plusvibe.is.null');

    if (error) {
      console.log('Error fetching from Supabase:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      console.log(`No pending Mailbox Accounts found for domain: ${domain}`);
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
    console.log(`Sending ${accountsToProcess.length} accounts to PlusVibe API`);

    const instance = axios.create({
      baseURL: this.apiBaseUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
    });
    await instance.post('/account/bulk-add-regular-accounts', {
      workspace_id: workspaceId,
      accounts: accountsToProcess,
    });

    console.log('Bulk add SMTP accounts request successful');

    // 3. Success! Update Supabase in bulk
    console.log('UPDATING SUPABASE RECORDS STATUS');

    const accountEmails = data.map((record) => record.email);

    const { error: updateError } = await this.sharedService
      .SupabaseClient()
      .from('mailboxes')
      .update({ added_to_plusvibe: true, status: 'warming' })
      .in('email', accountEmails); // Efficiently updates all processed emails at once

    if (updateError) {
      console.log('Error updating Supabase status:', updateError);
    }
  }
}
