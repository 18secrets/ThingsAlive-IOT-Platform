/**
 * `navigator.clipboard` only exists in a secure context (HTTPS, or the
 * `localhost` origin) — on a plain-HTTP LAN address (`http://192.168.x.x:3000`,
 * how this app gets reached from another machine on the network) it's simply
 * `undefined`, and every `navigator.clipboard?.writeText(...)` call across the
 * app silently no-ops: no error, no copy, no visible feedback. Falls back to
 * the legacy `execCommand('copy')` path, which isn't gated by secure context.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}
