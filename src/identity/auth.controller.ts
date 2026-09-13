import { Body, Controller, Headers, Ip, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { CredentialService } from './services/credential.service';

export class SignInDto {
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() password: string;
}

export class AcceptDto {
  @IsString() @IsNotEmpty() token: string;
  @IsString() @IsNotEmpty() password: string;
}

export class RefreshDto {
  @IsString() @IsNotEmpty() refreshToken: string;
}

export class ResetRequestDto {
  @IsEmail() email: string;
}

/**
 * Signing in, and the three things around it (task P1-88).
 *
 * Every route here is public by necessity — they are what somebody uses when they
 * have no token yet — and each carries its reason, because a blanket exemption is
 * how a privileged route ends up on an open list by accident.
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly credentials: CredentialService) {}

  @Post('sign-in')
  @Public('The route that produces a token cannot require one.')
  @ApiOperation({ summary: 'Exchange an email and password for a short access token' })
  signIn(
    @Body() body: SignInDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.credentials.signIn(body.email, body.password, { ipAddress: ip, userAgent });
  }

  @Post('accept-invitation')
  @Public('Accepting an invitation is how somebody gets their first credential.')
  @ApiOperation({ summary: 'Set a password with an invitation token and sign in' })
  accept(
    @Body() body: AcceptDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.credentials.acceptInvitation(body.token, body.password, { ipAddress: ip, userAgent });
  }

  @Post('refresh')
  @Public('The access token being refreshed has expired by definition.')
  @ApiOperation({ summary: 'Rotate a refresh token for a new access token' })
  refresh(
    @Body() body: RefreshDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.credentials.refresh(body.refreshToken, { ipAddress: ip, userAgent });
  }

  @Post('sign-out')
  @Public('Signing out must work with an expired access token, which is the common case.')
  @ApiOperation({ summary: 'End this sign-in and every token descended from it' })
  async signOut(@Body() body: RefreshDto) {
    await this.credentials.signOut(body.refreshToken);
    return { signedOut: true };
  }

  @Post('forgot-password')
  @Public('Somebody who cannot sign in is the only person who needs this.')
  @ApiOperation({ summary: 'Request a reset link. The answer never says whether the address exists' })
  async forgotPassword(
    @Body() body: ResetRequestDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    await this.credentials.requestReset(body.email, { ipAddress: ip, userAgent });
    // Identical whether or not an account was found. The token goes by email; it does
    // not come back down this response, or this route would be a way to take over any
    // account whose address somebody could guess.
    return { sent: true };
  }
}
