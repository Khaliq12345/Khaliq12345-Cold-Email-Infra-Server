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
}
