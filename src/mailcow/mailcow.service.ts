import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { SharedService } from 'src/shared/shared.service';

function generateUniqueAlphaNames(
  first: string,
  last: string,
  count: number = 100,
): string[] {
  const names = new Set<string>();
  const f = first.toLowerCase().trim();
  const l = last.toLowerCase().trim();
  const fi = f[0]; // first initial
  const li = l[0]; // last initial

  // 1. Core Patterns (Based on your "Nicole Soto" examples)
  const corePatterns = [
    f, // nicole
    `${f}.${li}`, // nicole.s
    `${fi}.${l}`, // n.soto
    `${fi}${li}`, // ns
    `${fi}${l}`, // nsoto
    `${f}${li}`, // nicoles
    `${f}.${l}`, // nicole.soto
  ];

  for (const name of corePatterns) {
    if (names.size < count) names.add(name);
  }

  // 2. Numeric Strategy (nicole2, nsoto1, etc.)
  // We iterate numbers and apply them to the base patterns
  let num = 1;
  while (names.size < count && num < 1000) {
    // Priority: common combinations with numbers
    const numericVariations = [
      `${fi}${l}${num}`, // nsoto1
      `${f}${num}`, // nicole2
      `${f}.${l}${num}`, // nicole.s13 (if num is 13)
      `${f}.${li}${num}`, // nicole.s1
      `${fi}.${l}${num}`, // n.soto1
    ];

    for (const v of numericVariations) {
      if (names.size < count) names.add(v);
    }
    num++;
  }

  return Array.from(names);
}

const generateStr = (len: number) =>
  Math.random()
    .toString(36)
    .substring(2, 2 + len);

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
    const allLocalparts = generateUniqueAlphaNames(firstName, lastName, total);

    // 2. Fetch existing emails from Supabase to prevent duplicates
    const existingEmails = await this.getExistingEmails(domain);

    // 3. FILTER: Only keep localparts that don't exist in the DB yet
    const localpartsToProcess = allLocalparts.filter((lp) => {
      const fullEmail = `${lp}@${domain}`;
      const dbRecord = existingEmails.find((rec) => rec.email === fullEmail);
      return !dbRecord || dbRecord.is_active === false;
    });

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
      };

      // send the mailboxes to mailcow
      const { data, error } = await this.supabase
        .SupabaseClient()
        .from('mailboxes')
        .upsert(payload, { onConflict: 'email' })
        .select()
        .single();

      if (error) {
        const errorMsg = `Failed to write to DB, skipping API for ${fullEmail}: ${error.message}`;
        this.logger.log(errorMsg);
        throw Error(errorMsg);
      }
      this.logger.log('Sent to supaabse');

      // Send the mailcow
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
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': token,
          },
        },
      );

      // --- FIXED LOGIC HERE ---
      const result = response.data[0];

      if (result?.type !== 'success') {
        // If the API says 'error', we jump to the catch block
        throw new Error(
          `Mailcow API returned: ${result?.msg || 'Unknown Error'}`,
        );
      }
      this.logger.log('Mailbox created');

      // --- STEP 3: UPDATE DB STATUS ON SUCCESS ---
      await this.supabase
        .SupabaseClient()
        .from('mailboxes')
        .update({ is_active: true })
        .eq('email', data.email);

      this.logger.log('Supabase updated');
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
