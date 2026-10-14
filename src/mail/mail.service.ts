import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';
import { corsOrigins } from '../config/env.validation';
import { MAIL_LOGO_CID, MAIL_LOGO_PNG } from './logo';
import { passwordResetHtml, passwordResetText } from './password-reset-template';

type Provider = 'resend' | 'sendgrid' | 'smtp';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** Sent alongside `text`, never instead of it: a client that blocks HTML shows the text. */
  html?: string;
  /** Images the HTML refers to as `cid:<cid>`, carried inside the message. */
  inline?: InlineImage[];
}

export interface InlineImage {
  cid: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

/**
 * Sends the few emails the platform owes people (dashboard testing, issue 10).
 *
 * Until this existed nothing was ever sent: forgot-password minted a reset token and
 * dropped it, and the screen still said "check your email". It speaks to an email
 * provider's HTTP API with Node's own `fetch`, or to a mailbox over SMTP.
 *
 *   MAIL_PROVIDER   resend | sendgrid | smtp. Unset means nothing is sent, and says so in the log.
 *   MAIL_API_KEY    resend / sendgrid: that provider's key.
 *   MAIL_FROM       the sender, an address the provider has verified. For smtp it defaults
 *                   to SMTP_USERNAME, because Microsoft 365 refuses any other From unless
 *                   the mailbox has been granted send-as on it.
 *   SMTP_HOST, SMTP_PORT (587), SMTP_USERNAME, SMTP_PASSWORD
 *                   smtp: the mailbox to send from, e.g. smtp.office365.com.
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
    return raw === 'resend' || raw === 'sendgrid' || raw === 'smtp' ? raw : null;
  }

  private setting(key: string): string {
    return `${this.config.get(key) ?? ''}`.trim();
  }

  /** Where a link in an email should point. */
  publicUrl(): string | null {
    const explicit = `${this.config.get('APP_PUBLIC_URL') ?? ''}`.trim();
    const base = explicit || corsOrigins(this.config.get<string>('CORS_ORIGINS'))[0] || '';
    return base ? base.replace(/\/+$/, '') : null;
  }

  async send(mail: OutgoingMail): Promise<boolean> {
    const provider = this.provider;
    if (provider === 'smtp') return this.sendSmtp(mail);
    const key = `${this.config.get('MAIL_API_KEY') ?? ''}`.trim();
    const from = `${this.config.get('MAIL_FROM') ?? ''}`.trim();
    if (!provider || !key || !from) {
      this.logger.warn(
        `Email "${mail.subject}" was not sent: set MAIL_PROVIDER (resend, sendgrid or smtp) and, for resend or sendgrid, MAIL_API_KEY and MAIL_FROM.`,
      );
      return false;
    }

    const request = provider === 'resend'
      ? {
          url: 'https://api.resend.com/emails',
          body: {
            from, to: [mail.to], subject: mail.subject, text: mail.text,
            ...(mail.html ? { html: mail.html } : {}),
            ...(mail.inline?.length ? {
              attachments: mail.inline.map((i) => ({
                filename: i.filename, content: i.content.toString('base64'), content_type: i.contentType, content_id: i.cid,
              })),
            } : {}),
          },
        }
      : {
          url: 'https://api.sendgrid.com/v3/mail/send',
          body: {
            personalizations: [{ to: [{ email: mail.to }] }],
            from: { email: from },
            subject: mail.subject,
            // SendGrid requires text/plain to come before text/html.
            content: [
              { type: 'text/plain', value: mail.text },
              ...(mail.html ? [{ type: 'text/html', value: mail.html }] : []),
            ],
            ...(mail.inline?.length ? {
              attachments: mail.inline.map((i) => ({
                content: i.content.toString('base64'), filename: i.filename, type: i.contentType,
                disposition: 'inline', content_id: i.cid,
              })),
            } : {}),
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

  private async sendSmtp(mail: OutgoingMail): Promise<boolean> {
    const host = this.setting('SMTP_HOST');
    const user = this.setting('SMTP_USERNAME');
    // Not trimmed: a password may legitimately start or end with a space.
    const pass = `${this.config.get('SMTP_PASSWORD') ?? ''}`;
    const from = this.setting('MAIL_FROM') || user;
    if (!host || !user || !pass) {
      this.logger.warn(
        `Email "${mail.subject}" was not sent: MAIL_PROVIDER is smtp, so set SMTP_HOST, SMTP_USERNAME and SMTP_PASSWORD.`,
      );
      return false;
    }

    const port = Number(this.setting('SMTP_PORT') || 587);
    try {
      await this.createSmtpTransport({
        host,
        port,
        // 465 is TLS from the first byte; anything else must upgrade with STARTTLS
        // before AUTH, or the password crosses the network in the clear.
        secure: port === 465,
        requireTLS: port !== 465,
        auth: { user, pass },
        // The same budget the HTTP providers get. The caller doesn't wait on this,
        // but a hung socket per reset request would still pile up.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      }).sendMail({
        from, to: mail.to, subject: mail.subject, text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.inline?.length ? {
          attachments: mail.inline.map((i) => ({
            filename: i.filename, content: i.content, contentType: i.contentType, cid: i.cid,
          })),
        } : {}),
      });
      return true;
    } catch (err) {
      // nodemailer's message carries the server's reply (e.g. "535 Authentication
      // unsuccessful"), never the password or the body with the reset token.
      this.logger.error(`smtp (${host}) refused "${mail.subject}": ${(err as Error).message}`);
      return false;
    }
  }

  /** Separate so a test can stand in for the network without a real mail server. */
  createSmtpTransport(options: SMTPTransport.Options): Transporter<SMTPTransport.SentMessageInfo> {
    return nodemailer.createTransport(options);
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
    const content = { link, validHours };
    return this.send({
      to,
      subject: 'Reset your IoT Platform password',
      text: passwordResetText(content),
      html: passwordResetHtml(content),
      inline: [{ cid: MAIL_LOGO_CID, filename: 'things-alive-logo.png', contentType: 'image/png', content: MAIL_LOGO_PNG }],
    });
  }
}
