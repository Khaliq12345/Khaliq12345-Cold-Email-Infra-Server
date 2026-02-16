import { Controller, Post, Body } from '@nestjs/common';
import { LoginDto } from './auth.login.dto';
import { AuthService } from './auth.service';
import { SignupDto } from './auth.signup.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async login(@Body() loginDto: LoginDto) {
    return await this.authService.login(loginDto);
  }

  @Post('signup')
  async signup(@Body() signupDto: SignupDto) {
    return await this.authService.signup(signupDto);
  }
}
