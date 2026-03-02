export class CreateMailboxesDto {
  domains: string[];
  firstName: string;
  lastName: string;
  total: number;
  isBulk: boolean;
  masterMailServerDomain: string;
}
