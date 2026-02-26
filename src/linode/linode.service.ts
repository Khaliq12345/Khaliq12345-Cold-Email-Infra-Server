import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SharedService } from 'src/shared/shared.service';

@Injectable()
export class LinodeService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private logger = new Logger(LinodeService.name);

  constructor(
    private configService: ConfigService,
    private sharedService: SharedService,
  ) {
    this.apiKey = this.configService.get('LINODE_KEY') as string;
    this.baseUrl = this.configService.get('LINODE_BASE_URL') as string;
  }

  async setupDomainDns(
    domainName: string,
    mailServer: string,
    relayIp: string,
  ) {
    try {
      const domainId = await this.ensureDomainExists(domainName);
      // 2. Define our "Source of Truth" for records
      const targetRecords = [
        { name: 'autoconfig', type: 'CNAME', target: mailServer },
        { name: 'autodiscover', type: 'CNAME', target: mailServer },
        { name: '', type: 'MX', target: mailServer, priority: 10 },
        { name: '', type: 'TXT', target: `v=spf1 mx a ip4:${relayIp} ~all` },
        { name: '_dmarc', type: 'TXT', target: 'v=DMARC1; p=none' },
      ];

      const srvRecord = {
        type: 'SRV',
        service: 'autodiscover',
        protocol: 'tcp',
        target: mailServer,
        priority: 0,
        weight: 0,
        port: 443,
      };

      // 3. Sync everything
      await this.reconcileDns(domainId, targetRecords, srvRecord);

      return { success: true, domainId };
    } catch (error) {
      this.logger.error(`DNS Setup failed for ${domainName}: ${error.message}`);
      throw error;
    }
  }

  async reconcileDns(domainId: number, targetRecords: any[], srvTarget: any) {
    this.logger.log(`Starting DNS reconciliation for Domain ID: ${domainId}`);

    // 1. Fetch current live records from Linode
    const { data: remote } = await axios.get(
      `${this.baseUrl}/domains/${domainId}/records`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
    );
    const liveRecords = remote.data;

    // 2. Reconcile Standard Records (A, MX, CNAME, TXT)
    for (const target of targetRecords) {
      const alreadyExists = liveRecords.find(
        (lr: any) =>
          lr.type === target.type &&
          lr.name === target.name &&
          lr.target.replace(/\.$/, '') === target.target.replace(/\.$/, ''), // Ignore trailing dots
      );

      if (!alreadyExists) {
        await this.createRecord(domainId, target);
      }
    }

    // 3. Reconcile SRV Record (Linode uses 'service' instead of 'name')
    const srvExists = liveRecords.find(
      (lr: any) => lr.type === 'SRV' && lr.service === srvTarget.service,
    );

    if (!srvExists) {
      await this.createRecord(domainId, srvTarget);
    }
  }

  async createRecord(domainId: number, payload: any) {
    try {
      await axios.post(
        `${this.baseUrl}/domains/${domainId}/records`,
        { ...payload, ttl_sec: 3600 },
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      this.logger.log(
        `Created ${payload.type} record for ${payload.name || payload.service}`,
      );
    } catch (e) {
      this.logger.error(
        `Failed to create ${payload.type}: ${e.response?.data?.errors?.[0]?.reason || e.message}`,
      );
      throw e;
    }
  }

  async getDomainId(domain: string) {
    const { data, error } = await this.sharedService
      .SupabaseClient()
      .from('master_relay_servers')
      .select('linode_domain_id')
      .eq('domain', domain)
      .single();

    if (error) {
      throw error;
    }
    return data.linode_domain_id;
  }

  async addArecord(domain: string, hostname: string, ipAddress: string) {
    const domainId = await this.getDomainId(domain);
    const url = `${this.baseUrl}/domains/${domainId}/records`;

    const data = {
      type: 'A',
      name: hostname,
      target: ipAddress,
      ttl_sec: 600,
    };

    const options = {
      method: 'POST',
      url: url,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      data: data,
    };

    try {
      const response = await axios.request(options);
      return response.data;
    } catch (error) {
      const errorMsg = error.response?.data || error.message;
      this.logger.error(errorMsg);
      return errorMsg;
    }
  }

  async openSupportTicket(linodeId: number, domain: string) {
    this.logger.log(`Opening Linode support ticket: for linode - ${linodeId}`);
    const url = `${this.baseUrl}/support/tickets`;

    const summary = `Requesting the removal of outbound Port 25`;
    const description = `Name - Khaliq Salawou
Organisation - Existantly
Domain - ${domain}
Link to public business information - https://app.existantly.com/

I am requesting the removal of outbound Port 25 restrictions to facilitate a distributed transactional and marketing mail relay system. This Linode instance will serve as a dedicated SMTP exit node for our primary application hub.

Sending Practices:

Transactional Only: We are sending user-initiated emails, including account activations, password resets, and system alerts.

Authentication: All outgoing mail is cryptographically signed using DKIM and authorized via SPF records.

Monitoring: We monitor bounce rates and FBL (Feedback Loops) to ensure our IP reputation remains high and our system is not compromised.`;

    const options = {
      method: 'POST',
      url: url,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      data: {
        linode_id: linodeId,
        summary: summary,
        description: description,
        severity: 1,
      },
    };

    try {
      const response = await axios.request(options);
      this.logger.log(`Ticket created successfully. ID: ${response.data.id}`);
      return response.data;
    } catch (error) {
      this.logger.error(
        `Linode API Error: ${error.response?.data?.errors?.[0]?.reason || error.message}`,
      );
      throw error;
    }
  }

  async ensureDomainExists(domainName: string): Promise<number> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/domains`,
        {
          domain: domainName,
          type: 'master',
          soa_email: 'n8n@existantly.com',
        },
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      return response.data.id;
    } catch (error) {
      // If it already exists, find the ID instead of failing
      if (
        error.response?.data?.errors?.[0]?.reason.includes('already exists')
      ) {
        const list = await axios.get(`${this.baseUrl}/domains`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        });
        const existing = list.data.data.find(
          (d: any) => d.domain === domainName,
        );
        return existing.id;
      }
      throw error;
    }
  }

  async addDkimRecord(domainName: string, selector: string, publicKey: string) {
    const domainId = await this.ensureDomainExists(domainName);
    const url = `${this.baseUrl}/domains/${domainId}/records`;

    const dkim_data = {
      name: `${selector}._domainkey`,
      type: 'TXT',
      target: `v=DKIM1; k=rsa; p=${publicKey}`,
      ttl_sec: 3600,
    };

    try {
      const response = await axios.post(url, dkim_data, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      return response.data;
    } catch (error) {
      this.logger.error(
        `Failed to add DKIM: ${error.response?.data?.errors?.[0]?.reason || error.message}`,
      );
      throw error;
    }
  }
}
