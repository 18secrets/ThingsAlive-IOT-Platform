import 'reflect-metadata'; // standalone script: Nest normally loads this for us

import dataSource from '../data-source';
import { PLATFORM_ROLES, PlatformRole } from '../../auth/platform-roles';
import { PlatformUser } from '../../identity/entities/platform-user.entity';
import { PasswordService } from '../../identity/services/password.service';

/**
 * Creates the first Things Alive staff credential, or any subsequent one.
 *
 * Run from a machine with a direct connection to the database — there is no HTTP
 * route for this, on purpose: the first platform user cannot be created by another
 * platform user, because there isn't one yet. That is the same bootstrap problem
 * `token:platform` (src/platform/mint-token.ts) always solved, moved from "mint a
 * stateless token with shell access to AUTH_JWT_SECRET" to "insert a row with shell
 * access to the database" — a different trust boundary, not a weaker one.
 *
 *   npx ts-node src/database/seeds/create-platform-user.ts \
 *     --email you@things-alive.io --name "Your Name" --password "..." [--role master-admin]
 */
function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const USAGE = `
Create a Things Alive staff credential.

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
    const normalised = email.trim().toLowerCase();
    if (await repo.findOne({ where: { email: normalised } })) {
      process.stderr.write(`\n${normalised} already has a platform credential.\n`);
      return 1;
    }

    const passwordHash = passwords.hash(password, normalised);
    const user = await repo.save(repo.create({ email: normalised, fullName, role, passwordHash }));
    process.stdout.write(
      `\nCreated ${role}: ${user.email} (${user.id})\n` +
      'Sign in at POST /auth/sign-in with this email and password.\n\n',
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
