import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class LinodeService {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private domainIds = { 'existantly.com': 3425878 };

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get('LINODE_KEY') as string;
    this.baseUrl = this.configService.get('LINODE_BASE_URL') as string;
  }

  async addArecord(domain: string, hostname: string, ipAddress: string) {
    const url = `${this.baseUrl}/domains/${this.domainIds[domain]}/records`;

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
      console.log(error);
      return error.response?.data || error.message;
    }
  }
}
