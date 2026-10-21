import { Body, Controller, Headers, Ip, Optional, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { MailService } from '../mail/mail.service';
import { CredentialService, RESET_HOURS } from './services/credential.service';
import { PasswordService } from './services/password.service';
import { PlatformCredentialService } from './services/platform-credential.service';

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
  constructor(
    private readonly credentials: CredentialService,
    private readonly platformCredentials: PlatformCredentialService,
    private readonly passwords: PasswordService,
    // Last and optional so the controller can be built without it in a test that
    // never resets a password; Nest always supplies it.
    @Optional() private readonly mail?: MailService,
  ) {}

  @Post('sign-in')
  @Public('The route that produces a token cannot require one.')
  @ApiOperation({ summary: 'Exchange an email and password for a short access token' })
  async signIn(
    @Body() body: SignInDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    // Staff first, by a cheap indexed lookup. An address can no longer be both a staff
    // and a client login (LoginEmailUnclaimed1759500000000), but pairs created before
    // that rule still exist, and taking the staff account for them locked the client
    // user out with "password incorrect" (dashboard testing, issue 2). For such a pair
    // the password decides: the staff account if it is theirs, otherwise the client
    // one, whose own lockout then counts the attempt. The check reads the hash only,
    // so a client signing in never adds failures to the staff account.
    const platformUser = await this.platformCredentials.findByEmail(body.email);
    if (platformUser) {
      const clientTwin = await this.credentials.hasAccount(body.email);
      if (clientTwin && !this.passwords.verify(body.password, platformUser.passwordHash)) {
        return this.credentials.signIn(body.email, body.password, { ipAddress: ip, userAgent });
      }
      return this.platformCredentials.signIn(body.email, body.password, { ipAddress: ip, userAgent });
    }
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
  async refresh(
    @Body() body: RefreshDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    if (await this.platformCredentials.hasSession(body.refreshToken)) {
      return this.platformCredentials.refresh(body.refreshToken, { ipAddress: ip, userAgent });
    }
    return this.credentials.refresh(body.refreshToken, { ipAddress: ip, userAgent });
  }

  @Post('sign-out')
  @Public('Signing out must work with an expired access token, which is the common case.')
  @ApiOperation({ summary: 'End this sign-in and every token descended from it' })
  async signOut(@Body() body: RefreshDto) {
    if (await this.platformCredentials.hasSession(body.refreshToken)) {
      await this.platformCredentials.signOut(body.refreshToken);
    } else {
      await this.credentials.signOut(body.refreshToken);
    }
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
    const ctx = { ipAddress: ip, userAgent };
    // A client user first, then staff: one screen serves both, and the set-password
    // screen the link opens accepts either kind of token.
    const client = await this.credentials.requestReset(body.email, ctx);
    const token = client.token ?? (await this.platformCredentials.requestReset(body.email, ctx)).token;
    // Sent without waiting, so the response takes as long for an unknown address as for
    // a known one. MailService logs a failure and never throws.
    if (token) void this.mail?.sendPasswordReset(body.email.trim().toLowerCase(), token, RESET_HOURS);
    // Identical whether or not an account was found. The token goes by email; it does
    // not come back down this response, or this route would be a way to take over any
    // account whose address somebody could guess.
    return { sent: true };
  }
}
