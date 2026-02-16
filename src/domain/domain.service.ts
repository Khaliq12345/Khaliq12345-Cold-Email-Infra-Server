// domain.service.ts
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SharedService } from 'src/shared/shared.service';

@Injectable()
export class DomainService {
  private readonly logger = new Logger(DomainService.name);
  constructor(private readonly service: SharedService) {}

  async addDomain(username: string, domain: string) {
    const { data, error } = await this.service
      .SupabaseClient()
      .from('domains')
      .insert([{ username, domain }])
      .select()
      .single(); // Returns the object instead of an array

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    return data;
  }

  async getDomainsByUser(username: string) {
    const client = this.service.SupabaseClient();

    const { data, error } = await client
      .from('domains')
      .select('*')
      .eq('username', username); // Assumes your column name is 'user'

    if (error) {
      this.logger.error(
        `Error fetching domains for user ${username}: ${error.message}`,
      );
      throw error;
    }

    return data;
  }
}
