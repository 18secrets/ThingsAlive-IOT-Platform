import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { ProvisionDto } from '../src/tenancy/tenancy.controller';
import { AccessDto, InviteDto } from '../src/identity/identity.controller';
import { RegisterBatchDto } from '../src/inventory/inventory.controller';
import { ProjectDto } from '../src/intelligence/intelligence.controller';
import {
  CreateTemplateClassDto, CreateTemplateScenarioDto,
} from '../src/catalog/catalog.controller';

const SRC = join(__dirname, '..', 'src');

/**
 * The validation boundary, which no other suite crosses (task P1-127).
 *
 * Found by deploying and pressing the button: `POST /api/v1/accounts` — the route that
 * creates every customer account — refused every well-formed request with
 * "property superAdmin should not exist". The DTO declared `superAdmin: SuperAdminDto`
 * with no decorator on it, and a pipe configured `whitelist` + `forbidNonWhitelisted`
 * does not ignore a property with no validation metadata: it strips it, then rejects
 * the request for carrying it. The one route Things Alive needs before any other was
 * dead on arrival.
 *
 * 642 tests passed over it because every one of them calls the service directly:
 * `provisioning.provision(scope, body)` never constructs a DTO, never runs a pipe, and
 * never sees the shape an HTTP caller actually has to send. This file is the boundary
 * itself, run through the same pipe main.ts installs.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const through = (metatype: any, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype, data: '' });

const controllerFiles = (dir: string = SRC): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return controllerFiles(full);
    return e.name.endsWith('.controller.ts') ? [full] : [];
  });

describe('the request validation boundary (P1-127)', () => {
  describe('a well-formed body is accepted', () => {
    it('provisions an account with its first super admin', async () => {
      // The exact body the runbook tells somebody to send.
      await expect(through(ProvisionDto, {
        tenantId: 'acme-industries',
        name: 'Acme Industries',
        plan: 'pilot',
        region: 'IN',
        superAdmin: { email: 'someone@acme.example', fullName: 'Their Name' },
        externalClients: [{ sourceSystem: 'things-alive-1.0', externalClientId: '42' }],
      })).resolves.toMatchObject({
        tenantId: 'acme-industries',
        superAdmin: { email: 'someone@acme.example' },
      });
    });

    it('invites a user with plant and equipment assignments', async () => {
      await expect(through(InviteDto, {
        email: 'operator@acme.example',
        fullName: 'An Operator',
        roleSlug: 'operational',
        plants: [{ plantId: '8f1e6d9c-0000-4000-8000-000000000001' }],
        equipment: [{ sourceSystem: 'things-alive-1.0', equipmentExternalId: 'DG-07' }],
      })).resolves.toMatchObject({ email: 'operator@acme.example' });
    });

    it('registers a batch of devices', async () => {
      await expect(through(RegisterBatchDto, {
        devices: [{ imei: '862174040000001' }, { imei: '862174040000002' }],
      })).resolves.toBeDefined();
    });

    it('projects a chain from named inputs', async () => {
      await expect(through(ProjectDto, {
        inputs: [{ signal: 'load_percent', value: 60 }],
      })).resolves.toBeDefined();
    });

    // The second instance of the same bug, found while drawing the Catalog screen:
    // both create routes read the slug with a keyed @Body beside a DTO that did not
    // declare it, so every correct call was refused. These are the first two routes
    // the Things Alive console calls after signing in.
    it('creates a template class from a body carrying its slug', async () => {
      await expect(through(CreateTemplateClassDto, {
        slug: 'diesel-generator',
        name: 'Diesel generator',
        category: 'power',
        expectedSignals: [{ signal: 'coolant_temp_c', unit: 'C', required: true }],
      })).resolves.toMatchObject({ slug: 'diesel-generator' });
    });

    it('creates a template scenario from a body carrying its slug', async () => {
      await expect(through(CreateTemplateScenarioDto, {
        slug: 'coolant-overheat',
        equipmentClassSlug: 'diesel-generator',
        name: 'Coolant running hot for the load',
        severity: 'warning',
        requiredSignals: ['coolant_temp_c', 'load_percent'],
      })).resolves.toMatchObject({ slug: 'coolant-overheat' });
    });

    it('refuses a template class with no slug', async () => {
      await expect(through(CreateTemplateClassDto, { name: 'Nameless' })).rejects.toThrow();
    });
  });

  describe('a malformed nested item is rejected', () => {
    // The other half of the same bug: before this, the outer array was validated and
    // its contents were not, so anything at all could arrive inside one.
    it('refuses a super admin without an email', async () => {
      await expect(through(ProvisionDto, {
        tenantId: 'acme-industries', name: 'Acme', superAdmin: { fullName: 'No Email' },
      })).rejects.toThrow();
    });

    it('refuses an equipment reference missing its source system', async () => {
      await expect(through(AccessDto, {
        equipment: [{ equipmentExternalId: 'DG-07' }],
      })).rejects.toThrow();
    });

    it('refuses a device entry that is not a device', async () => {
      await expect(through(RegisterBatchDto, {
        devices: [{ nonsense: true }],
      })).rejects.toThrow();
    });
  });

  /**
   * The guard against this happening again, derived rather than listed. A property
   * typed as another DTO carries no validation metadata unless it is told to, and the
   * failure is invisible in every test that does not cross the HTTP boundary.
   */
  it('every DTO property typed as another DTO declares @ValidateNested', () => {
    const offenders: string[] = [];
    for (const file of controllerFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // A property whose declared type is a Dto class, or an array of one.
        if (!/^\s*(?:@[\w({).,\s=>'"-]*\s*)*[\w]+\??:\s*\w+Dto(\[\])?;/.test(line)) return;
        // The decorators may sit on this line or on the lines just above it.
        const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (!context.includes('@ValidateNested')) {
          offenders.push(`${relative(SRC, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    // Naming them matters more than the count: each one is a route that either
    // refuses every request or accepts anything inside the nested object.
    expect(offenders).toEqual([]);
  });

  /**
   * The same failure in a different shape, and the reason it is a rule rather than a
   * fix: `@Body('slug') slug: string` beside `@Body() dto: SomeDto` reads one key out
   * of a body the pipe is simultaneously validating against a DTO that does not
   * declare it. The pipe strips the key as unknown and refuses the request — the
   * route cannot be called at all, and no test that invokes the service ever sees it.
   *
   * A method takes the whole body or named keys out of it, never both. When a route
   * genuinely needs a key, the DTO declares it and the handler reads it off the DTO,
   * which also puts the key under validation instead of beside it.
   */
  it('no handler mixes a keyed @Body with a whole-body @Body', () => {
    const offenders: string[] = [];
    for (const file of controllerFiles()) {
      const text = readFileSync(file, 'utf8');
      // A method declaration at class-body indentation, then its parameter list read
      // by balancing parentheses — decorators like `@Body('slug')` contain their own,
      // so a non-greedy `[^)]*` match silently finds nothing and the guard passes
      // while the bug is right there. It was written that way once already.
      for (const m of text.matchAll(/\n  (?:async )?\w+\(/g)) {
        const open = (m.index ?? 0) + m[0].length - 1;
        let depth = 0;
        let close = open;
        for (; close < text.length; close += 1) {
          if (text[close] === '(') depth += 1;
          else if (text[close] === ')') { depth -= 1; if (depth === 0) break; }
        }
        const params = text.slice(open + 1, close);
        if (/@Body\('/.test(params) && /@Body\(\)/.test(params)) {
          const line = text.slice(0, m.index ?? 0).split('\n').length + 1;
          offenders.push(`${relative(SRC, file)}:${line}  ${params.replace(/\s+/g, ' ').trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
