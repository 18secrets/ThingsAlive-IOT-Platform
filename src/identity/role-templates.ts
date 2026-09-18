import { Capability } from '../auth/capabilities';
import { ScopeShape } from './entities/tenant-role.entity';

export interface RoleTemplate {
  slug: string;
  name: string;
  description: string;
  scopeShape: ScopeShape;
  capabilities: Capability[];
  allowedTabs: string[];
}

/**
 * The three roles a client account starts with (task P1-21).
 *
 * Starting points, not settings. They are copied into an account at provisioning and
 * the client owns the copies from that moment — the same model as the equipment
 * catalog, and for the same reason: an account's access rules are that account's
 * business, and a template edited at Things Alive must never reach into one.
 *
 * They differ in the shape of their scope rather than in the amount of it, which is
 * why the three are worth shipping rather than one adjustable default.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    slug: 'ceo-manager',
    name: 'CEO / Manager',
    description:
      'The account\'s own administrator. Sees every site and machine, manages users '
      + 'and roles, owns the equipment register, and can move equipment between plants.',
    scopeShape: 'tenant',
    capabilities: [
      'user.manage', 'role.manage', 'equipment.write',
      'scenario.activate', 'scenario.author', 'alert.author', 'action.work', 'action.assign',
      'catalog.read', 'client-catalog.read', 'client-catalog.write',
      'prediction.read', 'prediction.run', 'utilization.read',
      'device.read', 'device.claim',
    ],
    allowedTabs: ['dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings'],
  },
  {
    slug: 'site-manager',
    name: 'Site manager',
    description:
      'Runs one or more sites. Sees the equipment at those sites and everything '
      + 'derived from it; sees nothing at a site they are not assigned to.',
    scopeShape: 'plant',
    capabilities: [
      'equipment.write', 'scenario.activate', 'alert.author', 'action.work', 'action.assign',
      'catalog.read', 'client-catalog.read',
      'prediction.read', 'prediction.run', 'utilization.read',
      'device.read', 'device.claim',
    ],
    allowedTabs: ['dashboard', 'ai-onboarding', 'alert-agent', 'admin', 'settings'],
  },
  {
    slug: 'operator',
    name: 'Operator',
    description:
      'Works the machines assigned to them. Sees each one\'s data and the work '
      + 'raised against it, for as long as the assignment stands.',
    scopeShape: 'equipment',
    capabilities: [
      'action.work', 'catalog.read', 'client-catalog.read',
      'prediction.read', 'utilization.read', 'device.read',
    ],
    allowedTabs: ['dashboard', 'alert-agent', 'settings'],
  },
];

export const ROLE_TEMPLATE_SLUGS = ROLE_TEMPLATES.map((t) => t.slug);
