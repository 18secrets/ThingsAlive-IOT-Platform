import { DEFAULT_EXPIRY_MINUTES, MintRefusal, mintPlatformToken } from './platform-token';

/**
 * `npm run token:platform -- --role master-admin --subject you@things-alive.io`
 *
 * Run it from the running service's shell, where AUTH_JWT_SECRET already is what the
 * service verifies against. Running it anywhere else produces a token the service
 * will reject, which is the confusing kind of wrong.
 */
function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

function main(argv = process.argv.slice(2), env = process.env): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const minutes = arg('minutes', argv);
  try {
    const minted = mintPlatformToken(
      {
        role: arg('role', argv) ?? 'master-admin',
        subject: arg('subject', argv) ?? '',
        tenantId: arg('tenant', argv),
        expiresInMinutes: minutes ? Number(minutes) : DEFAULT_EXPIRY_MINUTES,
      },
      {
        secret: env.AUTH_JWT_SECRET,
        issuer: env.AUTH_JWT_ISSUER,
        tenantClaim: env.AUTH_TENANT_CLAIM,
      },
    );

    // The summary first, then the token. Somebody about to paste a bearer token into
    // a browser should see what it grants and when it stops before they copy it.
    process.stdout.write(
      `\nrole      ${minted.role}\n` +
      `subject   ${minted.subject}\n` +
      `tenant    ${minted.tenantId}  (claim carried for the guard; not an account)\n` +
      `expires   ${minted.expiresAt.toISOString()}\n` +
      `\nAuthorization: Bearer\n${minted.token}\n\n` +
      'Paste it into /api-docs → Authorize. It cannot be revoked; it expires.\n\n',
    );
    return 0;
  } catch (error) {
    if (error instanceof MintRefusal) {
      process.stderr.write(`\nRefused: ${error.message}\n\n`);
      return 1;
    }
    throw error;
  }
}

const USAGE = `
Mint a platform token — the first credential on a fresh deployment.

  --role      master-admin | platform-support | catalog-author   (default: master-admin)
  --subject   who this is; recorded on everything they provision  (required)
  --tenant    tenant claim to carry                               (default: things-alive)
  --minutes   lifetime, capped at 7 days                          (default: 720)

Reads AUTH_JWT_SECRET, AUTH_JWT_ISSUER and AUTH_TENANT_CLAIM from the environment,
so run it where the service runs.
`;

if (require.main === module) process.exit(main());

export { main };
