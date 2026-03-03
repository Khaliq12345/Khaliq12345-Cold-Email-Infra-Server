export function mailServerConfig(
  sshPort: number,
  sshPubKey: string,
  myDomain: string,
) {
  const script = `#cloud-config
package_update: true
package_upgrade: true

packages:
  - git
  - openssl
  - curl
  - gawk
  - coreutils
  - grep
  - apt-transport-https
  - ca-certificates
  - gnupg
  - lsb-release
  - jq

users:
  - name: mailserver
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

  # 1. Install Docker using the official convenience script
  - [ sh, -c, "curl -fsSL https://get.docker.com | sh" ]

  # 2. Prepare Mailcow Directory
  - mkdir -p /opt/mailcow-dockerized
  - git clone https://github.com/mailcow/mailcow-dockerized /opt/mailcow-dockerized
  - cd /opt/mailcow-dockerized

  # 3. Generate Config non-interactively
  # We use 'env' to ensure variables are present for the script execution
  - |
    export MAILCOW_HOSTNAME="mail.${myDomain}"
    export MAILCOW_TZ="America/New_York"
    export MAILCOW_BRANCH="master"
    ./generate_config.sh

  # 4. Pull and Start
  - docker compose pull
  - docker compose up -d

  # 5. Schedule a reboot (delayed slightly to allow cloud-init to finish cleanly)
  - [ shutdown, -r, +1 ]`;

  return Buffer.from(script).toString('base64');
}

export function getCloudInitScript(
  sshPort: number,
  sshPubKey: string,
  myHostname: string,
  myDomain: string,
  parentRelayIP: string,
) {
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
