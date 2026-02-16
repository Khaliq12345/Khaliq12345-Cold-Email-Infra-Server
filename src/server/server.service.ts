import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';
import { SharedService } from 'src/shared/shared.service';

function generateDkimKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
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
  mailDomain: string,
  selector: string,
  dkimPrivateKey: string,
) {
  const dkimDir = '/var/lib/opendkim';
  const script = `#cloud-config
package_update: true
package_upgrade: true
packages:
  - fail2ban
  - ufw
  - postfix
  - opendkim
  - opendkim-tools
write_files:
  # Files created as root:root with default 0644 permissions
  - path: ${dkimDir}/${selector}.private
    content: |
${dkimPrivateKey
  .split('\n')
  .map((line) => '      ' + line)
  .join('\n')}
  - path: /etc/opendkim/SigningTable
    content: |
      *@${mailDomain} ${selector}._domainkey.${mailDomain}
  - path: /etc/opendkim/KeyTable
    content: |
      ${selector}._domainkey.${mailDomain} ${mailDomain}:${selector}:${dkimDir}/${selector}.private
  - path: /etc/opendkim/TrustedHosts
    content: |
      127.0.0.1
      ::1
      ${mailDomain}
      *.${mailDomain}
      ${parentRelayIP}
users:
  - name: relay
    groups: sudo
    shell: /bin/bash
    sudo: ['ALL=(ALL) NOPASSWD:ALL']
    ssh_authorized_keys:
      - ${sshPubKey}
runcmd:
  # 1. Handoff & Strict Permissions (Now that opendkim user exists)
  - mkdir -p /etc/opendkim
  - chown -R opendkim:opendkim /etc/opendkim
  - chown -R opendkim:opendkim ${dkimDir}
  - chmod 700 ${dkimDir}
  - chmod 600 ${dkimDir}/${selector}.private
  - chmod 644 /etc/opendkim/SigningTable /etc/opendkim/KeyTable /etc/opendkim/TrustedHosts
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
  - postconf -e "myhostname = ${myHostname}"
  - postconf -e "mydomain = ${myDomain}"
  - postconf -e "mynetworks = 127.0.0.0/8 [::ffff:127.0.0.0]/104 [::1]/128 ${parentRelayIP}"
  - postconf -e "inet_protocols = ipv4"
  - postconf -e "milter_default_action = accept"
  - postconf -e "milter_protocol = 6"
  - postconf -e "smtpd_milters = inet:127.0.0.1:8891"
  - postconf -e "non_smtpd_milters = inet:127.0.0.1:8891"
  - postconf -e "maillog_file = /var/log/mail.log"
  - bash -c 'touch /var/log/mail.log && chown syslog:adm /var/log/mail.log'
  # 5. Opendkim Config - Fixed to avoid leading whitespace
  - |
    cat > /etc/opendkim.conf <<'EOF'
    Syslog		yes
    SyslogSuccess		yes
    LogWhy		yes
    Canonicalization	relaxed/simple
    Mode			sv
    SubDomains		yes
    OversignHeaders	From
    UserID		opendkim
    UMask			007
    Socket		inet:8891@127.0.0.1
    PidFile		/run/opendkim/opendkim.pid
    TrustAnchorFile	/usr/share/dns/root.key
    InternalHosts         refile:/etc/opendkim/TrustedHosts
    KeyTable              refile:/etc/opendkim/KeyTable
    SigningTable          refile:/etc/opendkim/SigningTable
    EOF
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
    mailDomain: string,
    parentRelayIp: string,
  ) {
    // Generate the DKIM Key pair locally
    const { publicKey, privateKey } = generateDkimKeyPair();

    const updateData = {
      dkim_value: publicKey,
    };
    const { error } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .update(updateData)
      .eq('domain', mailDomain)
      .select();
    if (error) {
      this.logger.error(
        `Failed to update DKIM in DB for ${mailDomain}: ${error.message}`,
      );
      return;
    } else {
      this.logger.log(`✅ DKIM Public Key stored in DB for ${mailDomain}`);
    }

    // const uniqueId = crypto.randomBytes(4).toString('hex');
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
          mailDomain,
          'relay',
          privateKey,
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
