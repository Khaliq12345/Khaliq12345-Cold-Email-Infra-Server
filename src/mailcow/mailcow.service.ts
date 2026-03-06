import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { SharedService } from 'src/shared/shared.service';
import {
  generateStr,
  generateUniqueAlphaNames,
} from 'src/common/constants/working-with-text';
import { URLSearchParams } from 'url';

@Injectable()
export class MailcowService {
  private readonly logger = new Logger(MailcowService.name);

  constructor(private readonly supabase: SharedService) {}

  async getApiKey(masterMailServerDomain: string) {
    this.logger.log(
      `Retrieving api keys for domain - ${masterMailServerDomain}`,
    );
    const { data, error } = await this.supabase
      .SupabaseClient()
      .from('master_mail_servers')
      .select('api_key')
      .eq('domain', masterMailServerDomain)
      .single();
    if (error) {
      throw error;
    }
    return data.api_key;
  }

  async getExistingEmails(domain: string) {
    this.logger.log(`Retrieving existing emails of domain - ${domain}`);
    const { data, error } = await this.supabase
      .SupabaseClient()
      .from('mailboxes')
      .select('email, is_active')
      .eq('domain', domain);

    if (error) {
      this.logger.error(`Error fetching existing emails: ${error.message}`);
      return [];
    }

    return data;
  }

  async getMasterDomain(domain: string): Promise<string> {
    this.logger.log(`Retrieving the master domain for - ${domain}`);

    // 1. Execute query
    const { data, error } = await this.supabase
      .SupabaseClient()
      .from('domains')
      .select(
        `
        domain,
        master_mail_servers (
          domain
        )
      `,
      )
      .eq('domain', domain)
      .single();

    // Safeguard 1: Handle Database/Connection Errors immediately
    if (error) {
      const errorMsg = `Database error retrieving master domain for ${domain}: ${error.message}`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Safeguard 2: Check if the domain itself exists in the table
    if (!data) {
      const errorMsg = `No record found for domain: ${domain}`;
      this.logger.warn(errorMsg);
      throw new Error(errorMsg);
    }

    let masterMailServerDomain = data.master_mail_servers as any;
    masterMailServerDomain = Array.isArray(masterMailServerDomain)
      ? masterMailServerDomain[0].domain
      : masterMailServerDomain.domain;

    if (!masterMailServerDomain) {
      const errorMsg = `Domain ${domain} exists, but no master mail server is assigned to it.`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    return masterMailServerDomain;
  }

  async createMailboxes(
    domain: string,
    firstName: string,
    lastName: string,
    total: number,
  ) {
    // 1. Fetch existing emails from Supabase
    const existingEmails = await this.getExistingEmails(domain);
    const existingCount = existingEmails.length;

    // 2. Calculate remaining capacity (Max 100)
    const MAX_ALLOWED = 100;
    const remainingSlots = MAX_ALLOWED - existingCount;

    if (remainingSlots <= 0) {
      this.logger.warn(
        `Domain ${domain} has already reached the limit of ${MAX_ALLOWED} mailboxes.`,
      );
      return { success: false, message: 'Limit reached' };
    }

    // 3. Generate requested names
    const allLocalparts = generateUniqueAlphaNames(firstName, lastName, total);

    // 4. FILTER: Remove duplicates already in the DB
    const uniqueLocalparts = allLocalparts.filter((lp) => {
      const fullEmail = `${lp}@${domain}`;
      const dbRecord = existingEmails.find((rec) => rec.email === fullEmail);
      // Keep only if doesn't exist or is inactive
      return !dbRecord || dbRecord.is_active === false;
    });

    // 5. ENFORCE LIMIT: Cap the "to process" list to the remaining slots
    const localpartsToProcess = uniqueLocalparts.slice(0, remainingSlots);

    this.logger.log(
      `Existing: ${existingCount}. Adding: ${localpartsToProcess.length}. Total will be: ${existingCount + localpartsToProcess.length}`,
    );

    // Getting the master domain
    const masterMailServerDomain = await this.getMasterDomain(domain);

    for (const localpart of localpartsToProcess) {
      this.logger.log(`Processing localpart - ${localpart}`);
      const fullEmail = `${localpart}@${domain}`;
      const password = generateStr(50);

      const payload = {
        email: fullEmail,
        password: password,
        status: 'pending',
        domain: domain,
        first_name: firstName,
        last_name: lastName,
        username: fullEmail,
        imap_host: masterMailServerDomain,
        imap_port: '993',
        smtp_host: masterMailServerDomain,
        smtp_port: '465',
        is_active: false, // Start as false until API succeeds
      };

      // 6. DB Upsert
      const { data, error: dbError } = await this.supabase
        .SupabaseClient()
        .from('mailboxes')
        .upsert(payload, { onConflict: 'email' })
        .select()
        .single();

      if (dbError) {
        this.logger.error(
          `Failed DB write for ${fullEmail}: ${dbError.message}`,
        );
        continue; // Skip to next instead of crashing the whole loop
      }

      try {
        // 7. Mailcow API call
        const MAILCOW_API_BASE = `https://${masterMailServerDomain}/api/v1`;
        const token = await this.getApiKey(masterMailServerDomain);

        const response = await axios.post(
          `${MAILCOW_API_BASE}/add/mailbox`,
          {
            local_part: localpart,
            domain: domain,
            name: `${firstName} ${lastName}`,
            quota: '100',
            password: password,
            password2: password,
            active: '1',
            force_pw_update: '0',
            tls_enforce_in: '1',
            tls_enforce_out: '1',
          },
          {
            headers: { 'X-API-Key': token },
            timeout: 30000,
          },
        );

        const result = response.data[0];

        if (result?.type !== 'success') {
          throw new Error(`Mailcow API error: ${result?.msg}`);
        }

        // 8. Finalize DB Status
        await this.supabase
          .SupabaseClient()
          .from('mailboxes')
          .update({ is_active: true, status: 'active' })
          .eq('email', fullEmail);

        this.logger.log(`Success: ${fullEmail} created and activated.`);
      } catch (apiError) {
        this.logger.error(`API Failure for ${fullEmail}: ${apiError.message}`);
        // Optional: mark DB status as 'failed' here
      }
    }
  }

  async updateMailboxesQuota(
    quota: number,
    masterMailServerDomain: string,
    mailboxes?: string,
    domain?: string,
  ) {
    // Split the inputs or get the entire mailboxes of a domain
    let splittedMailboxes = mailboxes ? mailboxes.split(';') : [];
    if (splittedMailboxes.length == 0 && domain) {
      this.logger.log('Fallback to getting all the domains');
      splittedMailboxes = (
        await this.getMailboxes(domain, masterMailServerDomain)
      ).map((record: any) => record.username as string);
    }

    // Send the requests to update the mailboxes quota

    const MAILCOW_API_BASE = `https://${masterMailServerDomain}/api/v1`;
    const token = await this.getApiKey(masterMailServerDomain);
    const response = await axios.post(
      `${MAILCOW_API_BASE}/edit/mailbox`,
      {
        items: splittedMailboxes,
        attr: { quota: quota },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': token,
        },
      },
    );

    return response.data;
  }

  async getMailboxes(
    domain: string,
    masterMailServerDomain: string,
  ): Promise<Object[]> {
    this.logger.log(`GETTING THE MAILBOXES OF ${domain}`);

    const MAILCOW_API_BASE = `https://${masterMailServerDomain}/api/v1`;
    const token = await this.getApiKey(masterMailServerDomain);
    const response = await axios.get(
      `${MAILCOW_API_BASE}/get/mailbox/all`,

      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': token,
        },
      },
    );
    const records = response.data.filter(
      (record: any) => record.domain == domain,
    );
    return records;
  }

  async createDomain(
    masterMailServerDomain: string,
    domainName: string,
    description: string = 'Created via API',
  ): Promise<any> {
    this.logger.log(`CREATING MAILCOW DOMAIN: ${domainName}`);

    const MAILCOW_API_BASE = `https://${masterMailServerDomain}/api/v1`;
    const url = `${MAILCOW_API_BASE}/add/domain`;
    const token = await this.getApiKey(masterMailServerDomain);
    const body = {
      domain: domainName,
      description: description,
      aliases: 400,
      mailboxes: 100,
      defquota: 100,
      maxquota: 100,
      quota: 10400,
      active: 1,
      rl_value: '',
      rl_frame: 's',
      backupmx: 0,
      relay_all_recipients: 0,
      restart_sogo: '1',
    };

    try {
      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': token,
        },
      });

      return response.data;
    } catch (error) {
      this.logger.error(error);
      this.logger.error(
        `Mailcow Create Domain Error: ${error.response?.data} || ${error.message}`,
      );
      throw error;
    }
  }

  async setDomainTransport(
    domain: string,
    relayHostId: number,
    masterMailServerDomain: string,
  ): Promise<any> {
    this.logger.log(`ASSIGNING RELAY ID ${relayHostId} TO DOMAIN ${domain}`);
    try {
      const MAILCOW_API_BASE = `https://${masterMailServerDomain}/api/v1`;
      const token = await this.getApiKey(masterMailServerDomain);
      const url = `${MAILCOW_API_BASE}/edit/domain`;

      const body = {
        attr: {
          relayhost: relayHostId.toString(), // ID of the transport you created
        },
        items: [domain], // You can update multiple domains at once
      };

      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': token,
        },
      });

      return response.data;
    } catch (error) {
      return error.response?.data || error.message;
    }
  }

  async createDomainTransport(
    masterMailServerDomain: string,
    relayIp: string,
  ): Promise<any> {
    // Postfix/Mailcow literal IP format
    const isIp = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(relayIp);
    const formattedHost = isIp ? `[${relayIp}]:25` : `${relayIp}:25`;

    try {
      const token = await this.getApiKey(masterMailServerDomain);
      const url = `https://${masterMailServerDomain}/api/v1/add/relayhost`;

      // 1. Create the inner data object
      const attrData = {
        hostname: formattedHost,
        username: '',
        password: '',
      };

      // 2. Wrap it in URLSearchParams to force application/x-www-form-urlencoded
      const params = new URLSearchParams();
      params.append('attr', JSON.stringify(attrData));

      const response = await axios.post(url, params, {
        headers: {
          'X-API-Key': token,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      return response.data;
    } catch (error) {
      this.logger.error(`Mailcow API Error: ${error.message}`);
      return null;
    }
  }

  async getRelayHostIdByHostname(
    masterMailServerDomain: string,
    hostname: string,
  ): Promise<number | null> {
    try {
      const token = await this.getApiKey(masterMailServerDomain);
      const url = `https://${masterMailServerDomain}/api/v1/get/relayhost/all`;

      const response = await axios.get(url, {
        headers: { 'X-API-Key': token },
      });

      const parsedHostname = `[${hostname}]:25`;
      this.logger.log(parsedHostname);
      if (Array.isArray(response.data)) {
        // Find the entry matching our formatted hostname
        const match = response.data.find(
          (item) => item.hostname === parsedHostname,
        );
        return match ? parseInt(match.id) : null;
      }
      return null;
    } catch (error) {
      this.logger.error(`Failed to fetch relay hosts: ${error.message}`);
      return null;
    }
  }

  async getDatabaseMailboxesByDomain(domain: string) {
    const client = this.supabase.SupabaseClient();

    // Fetch all columns for mailboxes linked to the specified domain
    const { data, error } = await client
      .from('mailboxes')
      .select('*')
      .eq('domain', domain)
      .is('is_active', true);

    if (error) {
      this.logger.error(
        `Error fetching mailboxes for ${domain}: ${error.message}`,
      );
      throw error;
    }

    return data;
  }
}
