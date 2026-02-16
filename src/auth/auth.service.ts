import {
  Injectable,
  UnauthorizedException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { SharedService } from 'src/shared/shared.service';
import { LoginDto } from 'src/auth/auth.login.dto';
import { SignupDto } from 'src/auth/auth.signup.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly sharedService: SharedService) {}

  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const client = this.sharedService.SupabaseClient();

    // Perform the login via Supabase Auth
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      this.logger.error(`Login failed for ${email}: ${error.message}`);
      throw new UnauthorizedException(error.message);
    }

    const { session, user } = data;
    // Formatting the output to match your requested structure
    return {
      access_token: session.access_token,
      token_type: 'bearer' as const, // Explicitly casting to "bearer" literal
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      refresh_token: session.refresh_token,
      user: {
        id: user.id,
        email: user.email,
        confirmed_at: user.confirmed_at,
        last_sign_in_at: user.last_sign_in_at,
        created_at: user.created_at,
        updated_at: user.updated_at,
        is_anonymous: user.is_anonymous,
        user_metadata: {
          username: user.user_metadata?.username,
        },
      },
    };
  }

  async signup(signupDto: SignupDto) {
    const { email, password, firstname, lastname } = signupDto;
    const client = this.sharedService.SupabaseClient();

    const username = email.split('@')[0];

    // 2. Sign up in Supabase Auth with metadata
    const { data: authData, error: authError } = await client.auth.signUp({
      email,
      password,
      options: {
        data: {
          username: username,
          first_name: firstname,
          last_name: lastname,
        },
      },
    });

    if (authError) {
      this.logger.error(`Auth Signup failed: ${authError.message}`);
      throw new BadRequestException(authError.message);
    }

    if (!authData.user) {
      throw new BadRequestException('User registration failed.');
    }

    // 3. Create a row in the public 'users' table
    const { error: dbError } = await client.from('users').insert({
      id: authData.user.id, // Linking to Auth ID is standard practice
      username,
      email,
      firstname,
      lastname,
    });

    if (dbError) {
      this.logger.error(`Database user creation failed: ${dbError.message}`);
      // Note: You might want to handle cleaning up the auth user if this fails
      throw new BadRequestException('Profile creation failed');
    }

    return {
      message: 'Signup successful',
      user: authData.user,
    };
  }
}
