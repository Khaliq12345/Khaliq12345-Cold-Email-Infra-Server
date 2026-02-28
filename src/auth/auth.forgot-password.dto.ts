import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({
    description: 'The email address of the user requesting a password reset',
    example: 'user@example.com',
  })
  email: string;
}
