import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { DomainService } from 'src/domain/domain.service';
import { SharedService } from 'src/shared/shared.service';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private stripe: Stripe;
  private readonly logger = new Logger(StripeService.name);
  private readonly client: SupabaseClient;

  constructor(
    private configService: ConfigService,
    private sharedService: SharedService,
    private domainService: DomainService,
  ) {
    this.stripe = new Stripe(
      this.configService.get<string>('STRIPE_API_KEY') as string,
      {},
    );
    this.client = this.sharedService.SupabaseClient();
  }

  async domainExists(domain: string): Promise<boolean> {
    this.logger.debug(`Checking existence for domain: ${domain}`);

    const { data, error } = await this.client
      .from('domains')
      .select('domain')
      .eq('domain', domain)
      .maybeSingle(); // Returns null if not found instead of throwing an error

    if (error) {
      this.logger.error(`Supabase Check Error: ${error.message}`);
      throw error;
    }

    return !!data; // Returns true if data exists, false otherwise
  }

  async getExistingDomains(domains: string[]): Promise<string[]> {
    this.logger.debug(`Checking existence for ${domains.length} domains`);

    const { data, error } = await this.client
      .from('domains')
      .select('domain')
      .in('domain', domains);

    if (error) {
      this.logger.error(`Supabase Check Error: ${error.message}`);
      throw error;
    }

    // Extract the domain strings from the returned objects
    return data.map((row) => row.domain);
  }

  async createPaymentLink(
    domains: string[],
    username: string,
  ): Promise<Stripe.PaymentLink> {
    this.logger.log(`Initiating payment link creation for domains: ${domains}`);

    // Checking is user is an admin
    const { data, error } = await this.client
      .from('users')
      .select('is_admin')
      .eq('username', username)
      .single();

    if (error) {
      this.logger.error(`Error fetching user admin status: ${error.message}`);
      throw new InternalServerErrorException(
        `Error fetching user admin status: ${error.message}`,
      );
    }
    const isAdmin = data?.is_admin ?? false;

    // 1. Verify existence in Supabase first
    const existingDomains = await this.getExistingDomains(domains);
    const domainToProcess = domains.filter((d) => !existingDomains.includes(d));

    if (!domainToProcess) {
      this.logger.warn(
        `Payment Link aborted: All domains is already registered.`,
      );
      throw new ConflictException(`The domains has already been purchased.`);
    }

    const domainString = domainToProcess.join(';');
    if (domainString.length > 500) {
      this.logger.error(
        `Domain list too long for Stripe metadata (${domainString.length} chars)`,
      );
      // Handle error or use the Database Approach
      throw new BadRequestException(
        'Too many domains selected for a single checkout.',
      );
    }

    const quantity = domainToProcess.length;
    const pricePlan = isAdmin
      ? this.configService.get<string>('STRIPE_ADMIN_PLAN')
      : this.configService.get<string>('STRIPE_PLAN');
    // 2. Proceed with Stripe creation
    try {
      const paymentLink = await this.stripe.paymentLinks.create({
        line_items: [
          {
            price: pricePlan,
            quantity: quantity,
          },
        ],
        after_completion: {
          type: 'redirect',
          redirect: {
            url: `${this.configService.get('FRONTEND_BASE_URL')}/import/checkout/{CHECKOUT_SESSION_ID}`,
          },
        },
        metadata: { domains: domainToProcess.join(';'), username: username },
      });

      this.logger.log(`Payment Link created successfully: ${paymentLink.id}`);
      return paymentLink;
    } catch (error) {
      this.logger.error(`Stripe Error: ${error.message}`);
      throw new InternalServerErrorException(`Stripe Error: ${error.message}`);
    }
  }

  async markDomainsAsPaid(domains: string[], username: string) {
    this.logger.log(`Processing payment status for ${domains.length} domains`);

    // 1. Ensure all domains exist first
    for (const domain of domains) {
      await this.domainService.addDomain(username, domain);
    }

    // 2. Perform a single bulk update for all domains in the array
    const { data, error } = await this.sharedService
      .SupabaseClient()
      .from('domains')
      .update({ paid: true })
      .in('domain', domains)
      .eq('username', username)
      .select();

    if (error) {
      this.logger.error(`Failed to mark domains as paid: ${error.message}`);
      throw error;
    }

    this.logger.log(
      `Successfully marked ${data?.length || 0} domains as paid.`,
    );
    return data;
  }

  async handleCheckoutSuccess(checkoutId: string) {
    this.logger.log(`Attempting to retrieve checkout session: ${checkoutId}`);

    try {
      const session = await this.stripe.checkout.sessions.retrieve(checkoutId);

      const { domains, username } = session.metadata || {};

      if (!domains || !username) {
        this.logger.warn(
          `Metadata missing for session ${checkoutId}. Domain: ${domains}, User: ${username}`,
        );
        throw new Error('Incomplete metadata');
      }

      this.logger.log(
        `Session retrieved. Processing payment for Domain: ${domains} (User: ${username})`,
      );

      // Call Supabase
      const result = await this.markDomainsAsPaid(domains.split(';'), username);

      this.logger.log(
        `Successfully processed and saved payment for ${domains}`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `Failed to handle checkout success for ${checkoutId}: ${error.message}`,
      );
      throw new InternalServerErrorException(error.message);
    }
  }
}
