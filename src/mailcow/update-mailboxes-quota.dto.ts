export class UpdateMailboxesDto {
  mailboxes?: string;
  domain?: string;
  quota: number;
  masterMailServerDomain: string;
}
