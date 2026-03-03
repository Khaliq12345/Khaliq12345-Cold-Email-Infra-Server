import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { generateDkimKeyPair } from 'src/common/constants/generate-keys';
import { SharedService } from 'src/shared/shared.service';

@Injectable()
export class ServerService {
  private readonly logger = new Logger(ServerService.name);
  private readonly PROJECT_ID: string;
  private readonly TEMPLATE_ID: string;
  private readonly SEMAPHORE_URL: string;
  private readonly SEMAPHORE_API_TOKEN: string;
  private readonly MASTER_MAP_TEMPLATE_ID: string;

  private sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly sharedService: SharedService,
    private configService: ConfigService,
  ) {
    this.PROJECT_ID = this.configService.get('SEMAPHORE_PROJECT_ID') as string;
    this.TEMPLATE_ID = this.configService.get(
      'SEMAPHORE_TEMPLATE_ID',
    ) as string;
    this.SEMAPHORE_URL = this.configService.get('SEMAPHORE_URL') as string;
    this.SEMAPHORE_API_TOKEN = this.configService.get(
      'SEMAPHORE_API_TOKEN',
    ) as string;
    this.SEMAPHORE_URL = this.configService.get('SEMAPHORE_URL') as string;
    this.MASTER_MAP_TEMPLATE_ID = this.configService.get(
      'MASTER_MAP_TEMPLATE_ID',
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

  async waitForTask(taskId: any) {
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
      this.logger.log(`✅ Semaphore/Ansible task successfull`);
      return { success: true, taskId };
    } else {
      this.logger.error(
        `❌ Task ${taskId} failed or timed out with status: ${status}`,
      );
      throw new Error(`Ansible task failed: ${status}`);
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
    return await this.waitForTask(taskId);
  }

  async triggerMasterRelayMap(
    masterIp: string,
    domain: string,
    targetRelayIp: string,
  ) {
    const url = `${this.SEMAPHORE_URL}/api/project/${this.PROJECT_ID}/tasks`;

    const payload = {
      template_id: Number(this.MASTER_MAP_TEMPLATE_ID),
      limit: masterIp, // We run this ON the master server
      environment: JSON.stringify({
        target_domain: domain,
        relay_ip: targetRelayIp, // The IP of the child relay
      }),
      message: `Mapping ${domain} to relay ${targetRelayIp} on Master`,
    };

    const response = await axios.post(url, payload, {
      headers: { Authorization: `bearer ${this.SEMAPHORE_API_TOKEN}` },
    });
    return response.data;
  }

  async setupMasterRelayMapping(
    masterRelayIp: string,
    domainName: string,
    childRelayIp: string,
  ) {
    this.logger.log(
      `🔗 Mapping ${domainName} on Master Relay (${masterRelayIp}) -> ${childRelayIp}`,
    );

    // 2. Trigger Semaphore Task
    const task = await this.triggerMasterRelayMap(
      masterRelayIp,
      domainName,
      childRelayIp,
    );

    // 3. Optional: Reuse your polling logic here to wait for 'success'
    return this.waitForTask(task.id);
  }
}
