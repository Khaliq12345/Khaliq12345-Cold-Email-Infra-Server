import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

function formatDkimValue(dkimTxt: string) {
  const maxLength = 255;
  if (dkimTxt.length <= maxLength) return `"${dkimTxt}"`;

  const chunks: string[] = [];
  for (let i = 0; i < dkimTxt.length; i += maxLength) {
    chunks.push(dkimTxt.substring(i, i + maxLength));
  }
  return chunks.map((chunk) => `"${chunk}"`).join(' ');
}

@Injectable()
export class HetznerService {
  private readonly logger = new Logger(HetznerService.name);
  private readonly API_URL: string;
  private readonly API_TOKEN: string;

  constructor(private configService: ConfigService) {
    this.API_TOKEN = this.configService.get('HETZNER_API_KEY') as string;
    this.API_URL = this.configService.get('HETZNER_BASE_URL') as string;
  }

  async createZoneWithRecords(
    domainName: string,
    mailServerDomain: string,
    relayServerIp: string,
  ) {
    const payload = {
      name: domainName,
      mode: 'primary',
      ttl: 3600,
      rrsets: [
        {
          name: 'autoconfig',
          type: 'CNAME',
          records: [{ value: `${mailServerDomain}.` }],
          ttl: 3600,
        },
        {
          name: 'autodiscover',
          type: 'CNAME',
          records: [{ value: `${mailServerDomain}.` }],
          ttl: 3600,
        },
        {
          name: '@',
          type: 'MX',
          records: [{ value: `10 ${mailServerDomain}.` }],
          ttl: 3600,
        },
        {
          name: '_autodiscover._tcp',
          type: 'SRV',
          records: [{ value: `0 0 443 ${mailServerDomain}.` }],
          ttl: 3600,
        },
        {
          name: '@',
          type: 'TXT',
          records: [{ value: `"v=spf1 mx a ip4:${relayServerIp}"` }], // Value truncated from screenshot
          ttl: 3600,
        },
        {
          name: '_dmarc',
          type: 'TXT',
          records: [{ value: '"v=DMARC1; p=none"' }],
          ttl: 3600,
        },
      ],
    };

    try {
      const response = await axios.post(this.API_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.API_TOKEN}`,
        },
      });
      return response.data;
    } catch (error) {
      const message = error.response?.data?.error?.message || error.message;
      this.logger.error(
        `Failed to create zone: ${error.response?.data?.error?.message || error.message}`,
      );
      if ((message as string).includes('Zone already exists')) {
        return message;
      }
      throw error;
    }
  }

  async addDkimRecord(zoneName: string, selector: string, publicKey: string) {
    const url = `${this.API_URL}/${zoneName}/rrsets`;
    const formattedValue = formatDkimValue(`v=DKIM1; k=rsa; p=${publicKey}`);
    let dkim_data = {
      name: `${selector}._domainkey`,
      type: 'TXT',
      records: [
        {
          value: formattedValue,
        },
      ],
    };

    try {
      const response = await axios.post(url, dkim_data, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.API_TOKEN}`,
        },
      });

      return response.data;
    } catch (error) {
      const message = error.response?.data?.error?.message || error.message;
      this.logger.error(
        `Failed to update zone: ${error.response?.data?.error?.message || error.message}`,
      );
      if ((message as string).includes('RRSet(s) already exist(s)')) {
        return message;
      }
      throw error;
    }
  }
}
