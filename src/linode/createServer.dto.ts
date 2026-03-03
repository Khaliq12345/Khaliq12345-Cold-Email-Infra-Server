import { IsString, IsNotEmpty, IsIn, ValidateIf, IsIP } from 'class-validator';

export class CreateServerDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['mail', 'relay'])
  serverType: 'mail' | 'relay';

  @ValidateIf((o) => o.serverType === 'relay')
  @IsString()
  @IsNotEmpty({ message: 'hostname is required for relay servers' })
  hostname: string;

  @ValidateIf((o) => o.serverType === 'relay')
  @IsIP(4, { message: 'A valid parentIp is required for relay servers' })
  @IsNotEmpty()
  parentIp: string;

  @IsString()
  @IsNotEmpty()
  domain: string;
}
