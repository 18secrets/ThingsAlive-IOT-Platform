import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { corsOrigins } from '../config/env.validation';

type Provider = 'resend' | 'sendgrid';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends the few emails the platform owes people (dashboard testing, issue 10).
 *
 * Until this existed nothing was ever sent: forgot-password minted a reset token and
 * dropped it, and the screen still said "check your email". It speaks to an email
 * provider's HTTP API with Node's own `fetch`, so it adds no dependency.
 *
 *   MAIL_PROVIDER   resend | sendgrid. Unset means nothing is sent, and says so in the log.
 *   MAIL_API_KEY    that provider's key.
 *   MAIL_FROM       the sender, an address the provider has verified.
 *   APP_PUBLIC_URL  where links point. Defaults to the first CORS origin, the console.
 *
 * A failed send is logged and swallowed. Whoever triggered it must get the same answer
 * either way — for a reset, that is what stops the route telling a stranger which
 * addresses have accounts.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

  private get provider(): Provider | null {
    const raw = `${this.config.get('MAIL_PROVIDER') ?? ''}`.trim().toLowerCase();
    return raw === 'resend' || raw === 'sendgrid' ? raw : null;
  }

  /** Where a link in an email should point. */
  publicUrl(): string | null {
    const explicit = `${this.config.get('APP_PUBLIC_URL') ?? ''}`.trim();
    const base = explicit || corsOrigins(this.config.get<string>('CORS_ORIGINS'))[0] || '';
    return base ? base.replace(/\/+$/, '') : null;
  }

  async send(mail: OutgoingMail): Promise<boolean> {
    const provider = this.provider;
    const key = `${this.config.get('MAIL_API_KEY') ?? ''}`.trim();
    const from = `${this.config.get('MAIL_FROM') ?? ''}`.trim();
    if (!provider || !key || !from) {
      this.logger.warn(
        `Email "${mail.subject}" was not sent: set MAIL_PROVIDER (resend or sendgrid), MAIL_API_KEY and MAIL_FROM.`,
      );
      return false;
    }

    const request = provider === 'resend'
      ? {
          url: 'https://api.resend.com/emails',
          body: { from, to: [mail.to], subject: mail.subject, text: mail.text },
        }
      : {
          url: 'https://api.sendgrid.com/v3/mail/send',
          body: {
            personalizations: [{ to: [{ email: mail.to }] }],
            from: { email: from },
            subject: mail.subject,
            content: [{ type: 'text/plain', value: mail.text }],
          },
        };

    try {
      const res = await fetch(request.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // The provider's own words, never the key or the recipient's token.
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        this.logger.error(`${provider} refused "${mail.subject}": ${res.status} ${detail}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`${provider} could not be reached for "${mail.subject}": ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * The reset link opens the console's set-password screen, which already accepts
   * both a client token and a staff one.
   */
  async sendPasswordReset(to: string, token: string, validHours: number): Promise<boolean> {
    const base = this.publicUrl();
    if (!base) {
      this.logger.warn('Password reset email was not sent: set APP_PUBLIC_URL so the link has somewhere to point.');
      return false;
    }
    const link = `${base}/accept-invitation?invite=${encodeURIComponent(token)}&reset=1`;
    return this.send({
      to,
      subject: 'Reset your Things Alive password',
      text: [
        'Somebody asked to reset the password for this Things Alive account.',
        '',
        `Choose a new password here: ${link}`,
        '',
        `The link works once and expires in ${validHours} hour${validHours === 1 ? '' : 's'}.`,
        'If you did not ask for this, you can ignore this email; your password has not changed.',
      ].join('\n'),
    });
  }
}
