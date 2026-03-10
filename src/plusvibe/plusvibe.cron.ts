import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SharedService } from 'src/shared/shared.service';
import { PlusvibeService } from './plusvibe.service';

@Injectable()
export class PlusvibeCronService {
  private readonly logger = new Logger(PlusvibeCronService.name);

  constructor(
    private readonly sharedService: SharedService,
    private readonly service: PlusvibeService,
  ) {}
}
