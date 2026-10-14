/**
 * The password reset email, as HTML and as the plain text that travels with it.
 *
 * Built for mail clients, not browsers: tables for layout and every style inline,
 * because Outlook ignores <style> blocks and most of modern CSS, and Gmail strips
 * classes. The plain-text part is not a courtesy — it is what a client that blocks
 * HTML shows, and what spam filters weigh a message without one against.
 */

import { MAIL_LOGO_CID, MAIL_LOGO_HEIGHT, MAIL_LOGO_WIDTH } from './logo';

const BRAND = '#0284c7'; // the console's sky-600, so the email and the screen it opens match
const INK = '#0f172a';
const MUTED = '#64748b';
const PAGE = '#f4f7fb';

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ResetEmailContent {
  link: string;
  validHours: number;
}

export function passwordResetText({ link, validHours }: ResetEmailContent): string {
  return [
    'Somebody asked to reset the password for this IoT Platform account.',
    '',
    `Choose a new password here: ${link}`,
    '',
    `The link works once and expires in ${hours(validHours)}.`,
    'If you did not ask for this, you can ignore this email; your password has not changed.',
  ].join('\n');
}

export function passwordResetHtml({ link, validHours }: ResetEmailContent): string {
  const href = escape(link);
  // The logo travels inside the message (see logo.ts); width and height are set in
  // attributes as well as CSS because Outlook honours only the attributes.
  const header = `<img src="cid:${MAIL_LOGO_CID}" alt="Things Alive" width="${MAIL_LOGO_WIDTH}" height="${MAIL_LOGO_HEIGHT}" style="display:block;width:${MAIL_LOGO_WIDTH}px;height:${MAIL_LOGO_HEIGHT}px;border:0;outline:none;">`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Reset your IoT Platform password</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Choose a new password. The link expires in ${hours(validHours)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
        <tr>
          <td style="padding:0 4px 20px 4px;font-family:Segoe UI,Helvetica,Arial,sans-serif;">${header}</td>
        </tr>
        <tr>
          <td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
            <h1 style="margin:0 0 12px 0;font-size:20px;line-height:28px;font-weight:600;color:${INK};">Reset your password</h1>
            <p style="margin:0 0 24px 0;font-size:14px;line-height:22px;color:#334155;">
              Somebody asked to reset the password for this IoT Platform account. If it was you, choose a new one below.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="${BRAND}" style="border-radius:8px;">
                  <a href="${href}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Choose a new password</a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0 0;font-size:13px;line-height:20px;color:${MUTED};">
              The link works once and expires in <strong style="color:#334155;">${hours(validHours)}</strong>.
            </p>
            <p style="margin:16px 0 0 0;font-size:12px;line-height:18px;color:${MUTED};">
              Button not working? Paste this into your browser:<br>
              <a href="${href}" target="_blank" style="color:${BRAND};word-break:break-all;">${href}</a>
            </p>
            <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;">
            <p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};">
              Didn't ask for this? You can ignore this email &mdash; your password has not changed.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:20px 4px 0 4px;font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;line-height:16px;color:#94a3b8;">
            IoT Platform &middot; Sent because a password reset was requested for this address.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function hours(n: number): string {
  return `${n} hour${n === 1 ? '' : 's'}`;
}
