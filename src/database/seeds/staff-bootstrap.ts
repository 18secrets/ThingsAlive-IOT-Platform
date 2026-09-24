import 'reflect-metadata'; // standalone script: Nest normally loads this for us

import dataSource from '../data-source';
import { PLATFORM_ROLES, PlatformRole } from '../../auth/platform-roles';
import { PlatformUser } from '../../identity/entities/platform-user.entity';
import { PasswordService } from '../../identity/services/password.service';

/**
 * The one-time seam from a bootstrap token to a real login (task QPA1).
 *
 * `create-platform-user.ts` refuses a duplicate email; this refuses outright the
 * moment *any* `platform_user` row exists, because this script's only job is
 * standing up the very first Things Alive account on a fresh deployment. Every
 * account after that is QPA2's job — a staff invite, issued by somebody who is
 * already signed in — not a shell script run again.
 *
 *   npx ts-node src/database/seeds/staff-bootstrap.ts \
 *     --email you@things-alive.io --name "Your Name" --password "..." [--role master-admin]
 */
function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const USAGE = `
Bootstrap the first Things Alive staff credential. Refuses if one already exists.

  --email      sign-in address                                    (required)
  --name       full name                                          (required)
  --password   needs an uppercase, a lowercase, a number and a special character  (required)
  --role       ${PLATFORM_ROLES.join(' | ')}   (default: master-admin)
`;

async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const email = arg('email', argv);
  const fullName = arg('name', argv);
  const password = arg('password', argv);
  const role = (arg('role', argv) ?? 'master-admin') as PlatformRole;

  if (!email || !fullName || !password) {
    process.stderr.write(`${USAGE}\nMissing --email, --name or --password.\n`);
    return 1;
  }
  if (!PLATFORM_ROLES.includes(role)) {
    process.stderr.write(`\n"${role}" is not a platform role: ${PLATFORM_ROLES.join(', ')}\n`);
    return 1;
  }

  const passwords = new PasswordService();
  await dataSource.initialize();
  try {
    const repo = dataSource.getRepository(PlatformUser);
    const existing = await repo.count();
    if (existing > 0) {
      process.stderr.write(
        '\nRefused: a platform user already exists. This script bootstraps the first ' +
        'account only — use the staff invite flow for every one after it.\n\n',
      );
      return 1;
    }

    const normalised = email.trim().toLowerCase();
    const passwordHash = passwords.hash(password, normalised);
    const user = await repo.save(repo.create({ email: normalised, fullName, role, passwordHash }));
    process.stdout.write(
      `\nCreated ${role}: ${user.email} (${user.id})\n` +
      'Sign in at POST /api/v1/platform/auth/sign-in with this email and password.\n\n',
    );
    return 0;
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

export { main };
