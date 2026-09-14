import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { RequestScope } from '../../auth/types/request-scope';
import { ClientCatalogEntitlement } from '../entities/client-catalog-entitlement.entity';
import { EquipmentClassProfile } from '../entities/equipment-class-profile.entity';
import { ScenarioDefinition } from '../entities/scenario-definition.entity';
import { SignalAlias } from '../entities/signal-alias.entity';

/**
 * Reads the catalog as one tenant is entitled to see it (tasks P1-01, P1-04).
 *
 * The catalog is platform-owned and has no tenant column, so row-level security
 * cannot narrow it — the entitlement join is the only thing that does. That makes
 * this service the single place a tenant-context read may happen, and every method
 * here takes a scope for the same reason ScopedRepository does: so the narrowing
 * cannot be forgotten at a call site.
 *
 * Platform roles see the whole catalog. They are the people who write it.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    @InjectRepository(EquipmentClassProfile) private readonly classes: Repository<EquipmentClassProfile>,
    @InjectRepository(ScenarioDefinition) private readonly scenarioRepo: Repository<ScenarioDefinition>,
    @InjectRepository(SignalAlias) private readonly aliases: Repository<SignalAlias>,
    @InjectRepository(ClientCatalogEntitlement) private readonly entitlements: Repository<ClientCatalogEntitlement>,
  ) {}

  /** The class slugs this tenant may see. `null` means unrestricted (platform role). */
  async entitledSlugs(scope: RequestScope): Promise<string[] | null> {
    if (scope.isPlatformRole) return null;
    const rows = await this.entitlements.find({
      where: { tenantId: scope.tenantId, revokedAt: IsNull() },
    });
    return rows.map((r) => r.equipmentClassSlug);
  }

  /**
   * Published classes only, and only the latest version of each.
   *
   * A draft in the list would let a tenant activate something Things Alive has not
   * finished writing, and an older version alongside the current one is a choice
   * nobody outside the catalog team can make correctly.
   */
  async equipmentClasses(scope: RequestScope): Promise<EquipmentClassProfile[]> {
    const slugs = await this.entitledSlugs(scope);
    if (slugs?.length === 0) return [];

    const rows = await this.classes.find({
      where: { status: 'published' },
      order: { slug: 'ASC', version: 'DESC' },
    });
    const visible = slugs ? rows.filter((r) => slugs.includes(r.slug)) : rows;
    return latestPerSlug(visible);
  }

  /**
   * One class by slug.
   *
   * An unentitled class is a 404, not a 403. A 403 confirms the class exists, which
   * is commercial information: it tells a customer what Things Alive sells, and by
   * enumeration, roughly to whom.
   */
  async equipmentClass(scope: RequestScope, slug: string): Promise<EquipmentClassProfile> {
    const found = (await this.equipmentClasses(scope)).find((c) => c.slug === slug);
    if (!found) throw new NotFoundException(`No equipment class "${slug}".`);
    return found;
  }

  /** Published scenarios for a class the caller may see, latest version of each. */
  async scenariosForClass(scope: RequestScope, classSlug: string): Promise<ScenarioDefinition[]> {
    await this.equipmentClass(scope, classSlug); // entitlement check, and it 404s
    const rows = await this.scenarioRepo.find({
      where: { equipmentClassSlug: classSlug, status: 'published' },
      order: { slug: 'ASC', version: 'DESC' },
    });
    return latestPerSlug(rows);
  }

  /** Every scenario the tenant could conceivably run, across entitled classes. */
  async scenarios(scope: RequestScope): Promise<ScenarioDefinition[]> {
    const classes = await this.equipmentClasses(scope);
    if (!classes.length) return [];
    const slugs = classes.map((c) => c.slug);
    const rows = await this.scenarioRepo.find({
      where: slugs.map((equipmentClassSlug) => ({ equipmentClassSlug, status: 'published' as const })),
      order: { slug: 'ASC', version: 'DESC' },
    });
    return latestPerSlug(rows);
  }

  /**
   * Resolves upstream signal spellings to canonical names.
   *
   * Returned as a map rather than looked up one at a time, because the caller that
   * needs this is checking a whole asset's sensor map against a scenario's required
   * signals, and a query per signal would turn one page load into hundreds.
   */
  async aliasMap(sourceSystem: string): Promise<Map<string, string>> {
    const rows = await this.aliases.find();
    const map = new Map<string, string>();
    // Wildcard entries first, so a source-specific alias overrides the general one
    // rather than losing to whichever row the database happened to return second.
    for (const row of rows.filter((r) => r.sourceSystem === '*')) {
      map.set(row.alias.toLowerCase(), row.canonical);
    }
    for (const row of rows.filter((r) => r.sourceSystem === sourceSystem)) {
      map.set(row.alias.toLowerCase(), row.canonical);
    }
    return map;
  }

  /** An unknown spelling resolves to itself: unmapped is not the same as wrong. */
  canonicalise(signal: string, aliases: Map<string, string>): string {
    return aliases.get(signal.toLowerCase()) ?? signal;
  }
}

/**
 * Keeps the highest version of each slug. The caller orders by version DESC, so the
 * first row seen for a slug is the current one.
 */
function latestPerSlug<T extends { slug: string; version: number }>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const seen = best.get(row.slug);
    if (!seen || row.version > seen.version) best.set(row.slug, row);
  }
  return [...best.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
