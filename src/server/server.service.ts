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
  private readonly ansibleInventoryContent: string;
  private readonly AnsibleSSHKeyContent: string;
  private readonly availableRegions = [
    'us-mia',
    'us-sea',
    'us-east',
    'us-lax',
    'us-west',
  ];

  constructor(
    private readonly sharedService: SharedService,
    private configService: ConfigService,
  ) {
    this.apiKey = this.configService.get('LINODE_KEY') as string;
    this.baseUrl = this.configService.get('LINODE_BASE_URL') as string;
    this.sshKey = this.configService.get('SSH_KEY') as string;
    this.customPassword = this.configService.get('CUSTOM_PASSWORD') as string;
    this.ansibleInventoryContent = this.configService
      .get('ANSIBLE_INVENTORY_CONTENT')
      .replace(/\\n/g, '\n') as string;
    this.AnsibleSSHKeyContent = this.configService
      .get('ANSIBLE_SSH_KEY_CONTENT')
      .replace(/\\n/g, '\n') as string;
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

    // 4. Run Ansible with dynamic IPs
    const extraVars = {
      target_domain: domainName,
      injected_private_key: privateKey,
      parent_relay_ip: parentRelayIp, // Now dynamic!
    };

    const inventoryPath = '/tmp/hosts.yaml';
    writeFileSync(inventoryPath, this.ansibleInventoryContent);
    this.logger.log(this.ansibleInventoryContent);

    const keyPath = '/tmp/ansible_id_rsa';
    writeFileSync(keyPath, this.AnsibleSSHKeyContent, { encoding: 'utf8' });
    this.logger.log(this.AnsibleSSHKeyContent);

    chmodSync(keyPath, 0o600);

    // Ensure we use a JSON string for the extra-vars to handle the multiline private key
    const command = `ansible-playbook -vvv -i ${inventoryPath} configure_dkim.yaml --limit ${targetRelayIp} --extra-vars '${JSON.stringify(extraVars)}'`;

    this.logger.log(
      `🚀 Starting Ansible for ${domainName} on ${targetRelayIp}...`,
    );

    try {
      const { stdout, stderr } = await execPromise(command);

      this.logger.log(`✅ Ansible Success for ${domainName}:\n`, stdout);
      return stdout;
    } catch (err) {
      this.logger.error(
        `❌ Ansible Failed for ${domainName}:`,
        err.stderr || err.message,
      );
      throw new Error(`Ansible execution failed: ${err.message}`);
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
