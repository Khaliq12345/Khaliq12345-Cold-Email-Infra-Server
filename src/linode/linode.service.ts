import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { hostname } from 'os';
import {
  getCloudInitScript,
  mailServerConfig,
} from 'src/common/constants/cloud-config';
import { SharedService } from 'src/shared/shared.service';

@Injectable()
export class LinodeService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sshKey: string;
  private readonly customPassword: string;
  private readonly availableRegions = [
    'us-mia',
    'us-sea',
    'us-east',
    'us-lax',
    'us-west',
  ];
  private logger = new Logger(LinodeService.name);

  constructor(
    private configService: ConfigService,
    private sharedService: SharedService,
  ) {
    this.apiKey = this.configService.get('LINODE_KEY') as string;
    this.baseUrl = this.configService.get('LINODE_BASE_URL') as string;
    this.sshKey = this.configService.get('SSH_KEY') as string;
    this.customPassword = this.configService.get('CUSTOM_PASSWORD') as string;
  }

  async setupDomainDns(
    domainName: string,
    mailServer: string,
    relayIp: string,
    customRecords?: {
      name: string;
      type: string;
      target: string;
      priority?: number;
    }[],
    customSrv?: any,
  ) {
    try {
      const domainId = await this.ensureDomainExists(domainName);

      // 1. Use customRecords if provided, otherwise use the default Source of Truth
      const targetRecords = customRecords || [
        { name: 'autoconfig', type: 'CNAME', target: mailServer },
        { name: 'autodiscover', type: 'CNAME', target: mailServer },
        { name: '', type: 'MX', target: mailServer, priority: 10 },
        { name: '', type: 'TXT', target: `v=spf1 mx a ip4:${relayIp} ~all` },
        { name: '_dmarc', type: 'TXT', target: 'v=DMARC1; p=none' },
      ];

      // 2. Define default SRV or use custom
      const srvRecord = customSrv || {
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

  // SERVERS
  async getLinodesTypes() {
    const options = {
      method: 'GET',
      url: `${this.baseUrl}/linode/types`,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    };

    const response = await axios.request(options);
    return response.data;
  }

  async insertMailServer(data: any, domain: string) {
    const { error } = await this.sharedService
      .SupabaseClient()
      .from('master_mail_servers')
      .insert({
        server_id: data.id,
        domain: `mail.${domain}`,
        ip_address: data.ipv4[0],
        status: 'pending',
      });

    if (error) throw new Error(`Mail DB Error: ${error.message}`);
  }

  async insertRelayServer(data: any, hostname: string) {
    const { error } = await this.sharedService
      .SupabaseClient()
      .from('relay_servers') // Original table
      .insert({
        server_name: `ubuntu-${hostname}`,
        server_id: data.id,
        hostname: hostname,
        ipaddress: data.ipv4[0],
        status: 'pending',
      });

    if (error) throw new Error(`Relay DB Error: ${error.message}`);
  }

  async createLinode(
    hostname: string,
    domain: string,
    parentRelayIp: string,
    serverType: 'mail' | 'relay',
  ) {
    // 1. Define specific configurations based on type
    const typeConfig = {
      mail: {
        table: 'master_mail_servers',
        userData: mailServerConfig(6666, this.sshKey, domain),
      },
      relay: {
        table: 'relay_servers',
        userData: getCloudInitScript(
          6666,
          this.sshKey,
          hostname,
          domain,
          parentRelayIp,
        ),
      },
    };

    const selected = typeConfig[serverType];

    const linodeConfig = {
      region:
        this.availableRegions[
          Math.floor(Math.random() * this.availableRegions.length)
        ],
      type: serverType === 'relay' ? 'g6-nanode-1' : 'g6-standard-8',
      image: 'linode/ubuntu24.04',
      label:
        serverType === 'relay'
          ? `ubuntu-${hostname}`
          : `ubuntu-mailserver-${domain}`,
      root_pass: `${this.customPassword}-${hostname}`,
      metadata: {
        user_data: selected.userData,
      },
    };

    const options = {
      method: 'POST',
      url: `${this.baseUrl}/linode/instances`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      data: linodeConfig,
    };

    try {
      const response = await axios.request(options);

      const serverData = response.data;

      // 2. Separate Database Insertion Logic
      if (serverType === 'mail') {
        await this.insertMailServer(serverData, domain);
      } else {
        await this.insertRelayServer(serverData, hostname);
      }

      return serverData;
    } catch (error) {
      const errorData = error.response?.data;
      const isDuplicate = errorData?.errors?.some((err: any) =>
        err.reason.toLowerCase().includes('label must be unique'),
      );

      if (isDuplicate) {
        this.logger.warn(`Instance ${linodeConfig.label} exists. Fetching...`);
        return await this.getLinodeServer(linodeConfig.label);
      }

      throw error;
    }
  }

  async getLinodeServer(searchValue: string | number) {
    const filter = {
      '+or': [
        { label: String(searchValue) },
        { id: Number(searchValue) || 0 }, // Convert to number, fallback to 0 if NaN
      ],
    };

    const options = {
      method: 'GET',
      url: `${this.baseUrl}/linode/instances`,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'X-Filter': JSON.stringify(filter), // Stringify for safety
      },
    };

    try {
      const response = await axios.request(options);
      if (response.data?.data && response.data.data.length > 0) {
        return response.data.data[0];
      }

      return null; // Return null if no server matches
    } catch (error) {
      this.logger.error(
        `Linode Fetch Error: ${error.response?.data || error.message}`,
      );
      return null;
    }
  }

  async configureReverseDns(
    linodeId: number,
    ipAddress: string,
    relayHostname: string,
  ) {
    // The requests options
    const options = {
      method: 'PUT',
      url: `${this.baseUrl}/linode/instances/${linodeId}/ips/${ipAddress}`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      data: { rdns: relayHostname },
    };

    try {
      const response = await axios.request(options);
      return response.data;
    } catch (error) {
      return error.response?.data || error.message;
    }
  }

  // SUPPORT
  async oenSupportTicket(linodeId: number, domain: string) {
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
}
