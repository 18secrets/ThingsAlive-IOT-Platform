import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { ProvisionDto } from '../src/tenancy/tenancy.controller';
import { AccessDto, InviteDto } from '../src/identity/identity.controller';
import { RegisterBatchDto } from '../src/inventory/inventory.controller';
import { ProjectDto } from '../src/intelligence/intelligence.controller';

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
    const controllers = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        return e.name.endsWith('.controller.ts') ? [full] : [];
      });
    })(SRC);

    const offenders: string[] = [];
    for (const file of controllers) {
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
});
