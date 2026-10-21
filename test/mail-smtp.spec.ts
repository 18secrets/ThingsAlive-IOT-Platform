import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../src/mail/mail.service';

/**
 * Sending over SMTP, for an account that has a mailbox rather than an email API.
 *
 * Things Alive's own mail is Microsoft 365, which takes SMTP with a mailbox login and
 * nothing else without an API provider. The transport is stubbed: what is tested is what
 * the service asks the transport for — above all that it never offers the password over
 * an unencrypted connection — and that a refusal stays a logged `false`, never a throw
 * that would turn a reset request into an error and tell a stranger the address exists.
 */
describe('mail over smtp', () => {
  const PASSWORD = 'Sw0rdfish-in-the-config';
  let settings: Record<string, string>;
  let sendMail: jest.Mock;
  let createSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  const service = () => new MailService({ get: (key: string) => settings[key] } as unknown as ConfigService);
  const mail = { to: 'op@acme.test', subject: 'Reset your IoT Platform password', text: 'link: https://x/?invite=t0ken' };

  beforeEach(() => {
    settings = {
      MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.office365.com',
      SMTP_USERNAME: 'support@things-alive.test',
      SMTP_PASSWORD: PASSWORD,
    };
    sendMail = jest.fn().mockResolvedValue({ messageId: '<x@test>' });
    createSpy = jest.spyOn(MailService.prototype, 'createSmtpTransport')
      .mockReturnValue({ sendMail } as never);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends from the mailbox it logs in as, upgrading to TLS before it authenticates', async () => {
    await expect(service().send(mail)).resolves.toBe(true);

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'support@things-alive.test', pass: PASSWORD },
    }));
    expect(sendMail).toHaveBeenCalledWith({
      from: 'support@things-alive.test', to: 'op@acme.test', subject: mail.subject, text: mail.text,
    });
  });

  it('uses implicit TLS on 465, and an explicit MAIL_FROM when one is set', async () => {
    settings.SMTP_PORT = '465';
    settings.MAIL_FROM = 'Things Alive <no-reply@things-alive.test>';
    await service().send(mail);

    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ port: 465, secure: true, requireTLS: false }));
    expect(sendMail.mock.calls[0][0].from).toBe('Things Alive <no-reply@things-alive.test>');
  });

  it('sends nothing, and says what to set, when the mailbox is not configured', async () => {
    delete settings.SMTP_PASSWORD;
    await expect(service().send(mail)).resolves.toBe(false);

    expect(createSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/SMTP_HOST, SMTP_USERNAME and SMTP_PASSWORD/);
  });

  it('sends the reset as HTML and plain text, both carrying the same working link', async () => {
    settings.APP_PUBLIC_URL = 'https://console.example.test';
    await service().sendPasswordReset('op@acme.test', 'tok&en<1>', 2);

    const sent = sendMail.mock.calls[0][0];
    const link = 'https://console.example.test/accept-invitation?invite=tok%26en%3C1%3E&reset=1';
    expect(sent.text).toContain(link);
    // The token is percent-encoded into the URL first, so nothing in it can break out
    // of the href attribute; the &reset=1 separator is what HTML escaping touches.
    expect(sent.html).toContain(`href="${link.replace('&reset', '&amp;reset')}"`);
    expect(sent.html).toContain('expires in <strong style="color:#334155;">2 hours</strong>');
  });

  it('carries the logo inside the message, so no inbox has to fetch it', async () => {
    settings.APP_PUBLIC_URL = 'http://localhost:3000';
    await service().sendPasswordReset('op@acme.test', 'tok', 1);

    const { html, attachments } = sendMail.mock.calls[0][0];
    expect(html).toContain('src="cid:things-alive-logo"');
    expect(html).toContain('1 hour<');
    expect(attachments).toEqual([expect.objectContaining({ cid: 'things-alive-logo', contentType: 'image/png' })]);
    // A real PNG, not an empty buffer a broken build would leave behind.
    expect(attachments[0].content.subarray(1, 4).toString()).toBe('PNG');
  });

  it('turns a refused login into a logged false, without the password or the token in the log', async () => {
    sendMail.mockRejectedValue(new Error('Invalid login: 535 5.7.139 Authentication unsuccessful'));
    await expect(service().send(mail)).resolves.toBe(false);

    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toMatch(/535 5\.7\.139/);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('t0ken');
  });
});
