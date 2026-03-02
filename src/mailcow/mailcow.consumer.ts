import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SharedService } from 'src/shared/shared.service';
import { MailcowService } from './mailcow.service';

@Processor('mailcow-consumer', {
  concurrency: 10,
})
export class MailcowConsumer extends WorkerHost {
  private readonly logger = new Logger(MailcowConsumer.name);

  constructor(
    // private readonly sharedService: SharedService,
    private readonly mailcowService: MailcowService,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    switch (job.name) {
      case 'create-mailboxes': {
        const { domains, firstname, lastname, total } = job.data;

        for (const domain of domains) {
          try {
            this.logger.log(`Processing Domain - ${domain}`);

            // Await the service call so we can catch its specific error
            await this.mailcowService.createMailboxes(
              domain,
              firstname,
              lastname,
              total,
            );

            this.logger.log(`Successfully processed ${domain}`);
          } catch (error) {
            // One domain failing won't stop the loop now
            this.logger.error(
              `Failed to process domain ${domain}: ${error.message}`,
            );
          }
        }
      }
    }
  }
}
