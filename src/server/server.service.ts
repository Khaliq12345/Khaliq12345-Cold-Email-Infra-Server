import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { chmodSync, writeFileSync } from 'fs';
import * as crypto from 'crypto';
import { SharedService } from 'src/shared/shared.service';
import { exec } from 'child_process';
import { promisify } from 'util';
const execPromise = promisify(exec);

function generateDkimKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
    },
  });

  // Format the public key for DNS (remove headers and newlines)
  const formattedPublic = publicKey.replace(
    /-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n|\r/g,
    '',
  );

  return { publicKey: formattedPublic, privateKey };
}

function getCloudInitScript(
  sshPort: number,
  sshPubKey: string,
  myHostname: string,
  myDomain: string,
  parentRelayIP: string,
  // mailDomain: string,
  // selector: string,
  // dkimPrivateKey: string,
) {
  // const dkimDir = '/var/lib/opendkim';
  const script = `#cloud-config
package_update: true
package_upgrade: true
packages:
  - fail2ban
  - ufw
  - postfix
  - opendkim
  - opendkim-tools

users:
  - name: relay
    groups: sudo
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    ssh_authorized_keys:
      - ${sshPubKey}
runcmd:
  # 2. SSH Hardening
  - sed -i 's/^#\\?Port 22$/Port ${sshPort}/' /etc/ssh/sshd_config
  - sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  # 3. UFW Firewall
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow ${sshPort}/tcp
  - ufw allow 25/tcp
  - ufw --force enable
  # 4. Postfix Configuration
  - echo "postfix postfix/main_mailer_type string 'Internet Site'" | debconf-set-selections
  - postconf -e "myhostname = ${myHostname}.${myDomain}"
  - postconf -e "mydomain = ${myDomain}"
  - postconf -e "mynetworks = 127.0.0.0/8 [::ffff:127.0.0.0]/104 [::1]/128 ${parentRelayIP}"
  - postconf -e "inet_protocols = ipv4"
  - postconf -e "milter_default_action = accept"
  - postconf -e "milter_protocol = 6"
  - postconf -e "smtpd_milters = inet:127.0.0.1:8891"
  - postconf -e "non_smtpd_milters = inet:127.0.0.1:8891"
  - postconf -e "maillog_file = /var/log/mail.log"
  - bash -c 'touch /var/log/mail.log && chown syslog:adm /var/log/mail.log'
  # 6. Final Service Restart
  - systemctl enable fail2ban
  - systemctl restart fail2ban
  - systemctl restart opendkim
  - systemctl restart postfix
  - systemctl restart ssh.service
  - systemctl daemon-reload
  - systemctl restart ssh.socket
`;
  return Buffer.from(script).toString('base64');
}

@Injectable()
export class ServerService {
  private readonly logger = new Logger(ServerService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sshKey: string;
  private readonly customPassword: string;
  private readonly PROJECT_ID: number;
  private readonly TEMPLATE_ID: number;
  private readonly SEMAPHORE_URL: string;
  private readonly SEMAPHORE_API_TOKEN: string;
  private readonly availableRegions = [
    'us-mia',
    'us-sea',
    'us-east',
    'us-lax',
    'us-west',
  ];

  private sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly sharedService: SharedService,
    private configService: ConfigService,
  ) {
    this.apiKey = this.configService.get('LINODE_KEY') as string;
    this.baseUrl = this.configService.get('LINODE_BASE_URL') as string;
    this.sshKey = this.configService.get('SSH_KEY') as string;
    this.customPassword = this.configService.get('CUSTOM_PASSWORD') as string;
    this.PROJECT_ID = 1;
    this.TEMPLATE_ID = 1;
    this.SEMAPHORE_URL = this.configService.get('SEMAPHORE_URL') as string;
    this.SEMAPHORE_API_TOKEN = this.configService.get(
      'SEMAPHORE_API_TOKEN',
    ) as string;
  }

  async getSemaphoreTaskStatus(taskId: number) {
    // Point to the specific Task ID to get its current status
    const url = `${this.SEMAPHORE_URL}/api/project/${this.PROJECT_ID}/tasks/${taskId}`;

    try {
      const response = await axios.get(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.SEMAPHORE_API_TOKEN}`,
        },
      });
      return response.data;
    } catch (error) {
      this.logger.error(
        `❌ Failed to fetch task status for ID ${taskId}: ${error.response?.data?.message || error.message}`,
      );
      throw error;
    }
  }

  async triggerDkimSetup(
    targetIp: string,
    domain: string,
    privateKey: string,
    parentRelayIp: string,
  ) {
    const url = `${this.SEMAPHORE_URL}/api/project/${this.PROJECT_ID}/tasks`;

    const payload = {
      template_id: Number(this.TEMPLATE_ID),
      debug: true,
      dry_run: false,
      diff: false,
      limit: targetIp,
      environment: JSON.stringify({
        target_domain: domain,
        injected_private_key: privateKey,
        parent_relay_ip: parentRelayIp,
      }),
      message: `Provisioning DKIM for ${domain} via NestJS API`,
    };

    try {
      const response = await axios.post(url, payload, {
        headers: {
          Authorization: `bearer ${this.SEMAPHORE_API_TOKEN}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
      });
      this.logger.log(
        `🚀 Semaphore Task Queued: ID ${response.data.id} for ${domain}`,
      );
      return response.data;
    } catch (error) {
      const errorMsg = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;
      this.logger.error(`❌ Failed to trigger Semaphore: ${errorMsg}`);
      throw error;
    }
  }

  async assignAndSetupDkim(domainName: string, relayServerName: string) {
    const client = this.sharedService.SupabaseClient();

    // 1. Fetch the Target Server IP and the Parent (Master) Relay IP
    const { data: serverInfo, error: serverErr } = await client
      .from('relay_servers')
      .select(
        `
        ipaddress,
        master_relay_servers (
          ip_address
        )
      `,
      )
      .eq('server_name', relayServerName)
      .single();

    if (serverErr || !serverInfo) {
      console.error(
        `Failed to fetch IP info for ${relayServerName}:`,
        serverErr,
      );
      throw serverErr;
    }

    const targetRelayIp = serverInfo.ipaddress;
    const parentRelayIp = (serverInfo.master_relay_servers as any)?.ip_address;

    // 2. Generate keys locally
    const { publicKey, privateKey } = generateDkimKeyPair();

    // 3. Save publicKey to Supabase so user sees DNS instructions immediately
    const { error: updateErr } = await client
      .from('domains')
      .update({ dkim_value: publicKey })
      .eq('domain', domainName);

    if (updateErr) {
      console.error(`Failed to update DKIM for ${domainName}:`, updateErr);
      throw updateErr;
    }

    const task = await this.triggerDkimSetup(
      targetRelayIp,
      domainName,
      privateKey,
      parentRelayIp,
    );
    const taskId = task.id;
    this.logger.log(`⏳ Monitoring Task ID: ${taskId} for ${domainName}...`);

    // 2. Poll until finished
    let status = 'pending';
    let attempts = 0;
    const maxAttempts = 30; // 30 * 5 seconds = 2.5 minutes timeout

    while (
      status !== 'success' &&
      status !== 'error' &&
      attempts < maxAttempts
    ) {
      await this.sleep(5000); // Wait 5 seconds between checks

      const taskDetails = await this.getSemaphoreTaskStatus(taskId);
      status = taskDetails.status;

      this.logger.log(`🔄 Task ${taskId} Current Status: ${status}`);
      attempts++;
    }

    if (status === 'success') {
      this.logger.log(`✅ DKIM Provisioned successfully for ${domainName}`);
      return { success: true, taskId };
    } else {
      this.logger.error(
        `❌ Task ${taskId} failed or timed out with status: ${status}`,
      );
      throw new Error(`Ansible task failed: ${status}`);
    }
  }

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

  async createLinode(
    relayHostname: string,
    relayDomain: string,
    parentRelayIp: string,
  ) {
    const linodeConfig = {
      region:
        this.availableRegions[
          Math.floor(Math.random() * this.availableRegions.length)
        ],
      type: 'g6-nanode-1',
      image: 'linode/ubuntu24.04',
      label: `ubuntu-${relayHostname}`,
      root_pass: `${this.customPassword}-${relayHostname}`,
      metadata: {
        user_data: getCloudInitScript(
          6666,
          this.sshKey,
          relayHostname,
          relayDomain,
          parentRelayIp,
        ),
      },
    };

    // The requests options
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

      const { error: dbError } = await this.sharedService
        .SupabaseClient()
        .from('relay_servers')
        .insert({
          server_name: `ubuntu-${relayHostname}`,
          server_id: response.data.id,
          status: 'pending',
          ipaddress: response.data.ipv4[0],
          hostname: relayHostname,
        });

      // 2. Handle potential DB errors
      if (dbError) {
        this.logger.error(`Database insert failed: ${dbError.message}`);
        throw dbError;
      }

      return response.data;
    } catch (error) {
      const errorData = error.response?.data;

      // We check if any error mentions that the 'label' is already in use.
      const isDuplicate = errorData?.errors?.some((err: any) =>
        err.reason
          .toLowerCase()
          .includes('Label must be unique among your linodes'.toLowerCase()),
      );
      console.log('is Dup', isDuplicate);

      if (isDuplicate) {
        this.logger.warn(
          `Instance ${linodeConfig.label} already exists. Fetching existing instance...`,
        );
        // Call your existing function to get the instance
        return await this.getLinodeServer(linodeConfig.label);
      }

      // If it's a different error, throw it or return the data
      return errorData || error.message;
    }
  }

  async getLinodeServer(label: string) {
    const options = {
      method: 'GET',
      url: `${this.baseUrl}/linode/instances`,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'X-Filter': `{"label": "${label}"}`,
      },
    };

    try {
      const response = await axios.request(options);
      if (response.data && response.data && response.data.data.length > 0) {
        return response.data.data[0];
      }
    } catch (error) {
      return error.response?.data || error.message;
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
}
