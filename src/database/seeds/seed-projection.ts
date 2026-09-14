import 'reflect-metadata'; // standalone script: Nest normally loads this for us

import { plainToInstance } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { EquipmentSnapshotEnvelope } from '../../projection/contracts/contracts';
import { ProjectionRejection } from '../../projection/entities/projection-rejection.entity';
import { TenantMap } from '../../projection/entities/tenant-map.entity';
import { ProjectionService } from '../../projection/services/projection.service';
import dataSource from '../data-source';

/**
 * The stand-in producer (task P1-43).
 *
 * It reads a file and pushes it through exactly the contract and the service the
 * real producer will use. That is the point: when the existing platform starts
 * publishing snapshots, this script is replaced and nothing downstream changes.
 * Building the integration first and the structure afterwards is how a scope filter
 * ends up bolted onto forty endpoints that already shipped without one.
 *
 *   npx ts-node src/database/seeds/seed-projection.ts [file.json]
 */
async function main() {
  const file = process.argv[2] ?? join(__dirname, 'example-snapshot.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));

  const envelope = plainToInstance(EquipmentSnapshotEnvelope, raw);
  await validateOrReject(envelope, { whitelist: true, forbidNonWhitelisted: true });

  const ds: DataSource = await dataSource.initialize();
  try {
    const service = new ProjectionService(ds.getRepository(TenantMap), ds);

    const result = await service.apply(envelope);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));

    const rejected = await ds.getRepository(ProjectionRejection).count();
    if (rejected) {
      // Loud on purpose: rejected rows usually mean tenant_map is missing an entry,
      // and a half-synced fleet looks like a working one until someone counts.
      // eslint-disable-next-line no-console
      console.warn(`${rejected} row(s) rejected. Check projection_rejection before trusting this sync.`);
      process.exitCode = 1;
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
