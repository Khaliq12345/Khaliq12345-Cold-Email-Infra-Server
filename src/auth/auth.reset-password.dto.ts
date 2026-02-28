import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'The new password for the account',
    example: 'newSecurePassword123',
  })
  password: string;

  @ApiProperty({
    description: 'The verification token sent via email',
    required: true,
  })
  accessToken: string;

  @ApiProperty({
    description:
      'The verification refresh token sent via email',
    required: true,
  })
  refreshToken: string;
}
