import { Controller } from '@nestjs/common';
import { ServerService } from 'src/server/server.service';

@Controller('servers')
export class ServerController {
  constructor(private readonly serverService: ServerService) {}
}
