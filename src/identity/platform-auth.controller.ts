import { Body, Controller, Headers, Ip, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { CurrentScope } from '../auth/decorators/current-scope.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { RequestScope } from '../auth/types/request-scope';
import { AcceptDto, RefreshDto, SignInDto } from './auth.controller';
import { PlatformCredentialService } from './services/platform-credential.service';

export class ChangePasswordDto {
  @IsString() @IsNotEmpty() currentPassword: string;
  @IsString() @IsNotEmpty() newPassword: string;
}

/**
 * The Things Alive login (task QPA1).
 *
 * A separate surface from `/auth`, on purpose: staff hold a `platform_user` row, not
 * an `app_user` one, and a Things Alive credential signing in at a tenant's own login
 * route is the collision `/auth/sign-in` otherwise has to detect and disambiguate.
 * Every route here is public for the same reasons `AuthController`'s are, except
 * `change-password`, which by definition needs to know who is already signed in.
 */
@ApiTags('Platform Authentication')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly platformCredentials: PlatformCredentialService) {}

  @Post('sign-in')
  @Public('The route that produces a token cannot require one.')
  @ApiOperation({ summary: 'Exchange a Things Alive staff email and password for a short access token' })
  signIn(@Body() body: SignInDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string) {
    return this.platformCredentials.signIn(body.email, body.password, { ipAddress: ip, userAgent });
  }

  @Post('accept-invitation')
  @Public('Accepting an invitation is how a staff member gets their first credential.')
  @ApiOperation({ summary: 'Set a password with a staff invitation token and sign in' })
  accept(@Body() body: AcceptDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string) {
    return this.platformCredentials.acceptInvitation(body.token, body.password, { ipAddress: ip, userAgent });
  }

  @Post('refresh')
  @Public('The access token being refreshed has expired by definition.')
  @ApiOperation({ summary: 'Rotate a platform refresh token for a new access token' })
  refresh(@Body() body: RefreshDto, @Ip() ip: string, @Headers('user-agent') userAgent?: string) {
    return this.platformCredentials.refresh(body.refreshToken, { ipAddress: ip, userAgent });
  }

  @Post('sign-out')
  @Public('Signing out must work with an expired access token, which is the common case.')
  @ApiOperation({ summary: 'End this platform sign-in and every token descended from it' })
  async signOut(@Body() body: RefreshDto) {
    await this.platformCredentials.signOut(body.refreshToken);
    return { signedOut: true };
  }

  @Post('change-password')
  @ApiOperation({ summary: 'Change the signed-in staff member\'s own password' })
  async changePassword(
    @CurrentScope() scope: RequestScope,
    @Body() body: ChangePasswordDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    await this.platformCredentials.changePassword(
      scope.userId, body.currentPassword, body.newPassword, { ipAddress: ip, userAgent },
    );
    return { changed: true };
  }
}
