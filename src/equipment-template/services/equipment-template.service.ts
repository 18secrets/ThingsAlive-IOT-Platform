import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EquipmentTemplate } from '../entities/equipment-template.entity';

type TemplateDraft = Partial<Pick<EquipmentTemplate,
  'name' | 'category' | 'manufacturer' | 'engineType' | 'fuelTankCapacityLiters'
  | 'serviceIntervalHours' | 'description'>>;

/**
 * Flat CRUD, no lifecycle — onboarding convenience, not a versioned product. See the
 * entity's own comment on why this stays separate from `CatalogAuthoringService`.
 */
@Injectable()
export class EquipmentTemplateService {
  constructor(
    @InjectRepository(EquipmentTemplate) private readonly templates: Repository<EquipmentTemplate>,
  ) {}

  list(): Promise<EquipmentTemplate[]> {
    return this.templates.find({ order: { name: 'ASC' } });
  }

  create(draft: TemplateDraft): Promise<EquipmentTemplate> {
    if (!draft.name?.trim()) throw new BadRequestException('A template needs a name.');
    return this.templates.save(this.templates.create({
      name: draft.name.trim(),
      category: draft.category ?? null,
      manufacturer: draft.manufacturer ?? null,
      engineType: draft.engineType ?? null,
      fuelTankCapacityLiters: draft.fuelTankCapacityLiters ?? null,
      serviceIntervalHours: draft.serviceIntervalHours ?? null,
      description: draft.description ?? null,
    }));
  }

  async update(id: string, draft: TemplateDraft): Promise<EquipmentTemplate> {
    const template = await this.templates.findOne({ where: { id } });
    if (!template) throw new NotFoundException(`No equipment template "${id}".`);
    // `draft` is a class-validator DTO: every optional field TypeScript declares is
    // defined as an own property (value `undefined`) at construction time, even when
    // the request body omitted it — an ordinary Object.assign would copy those
    // `undefined`s onto the entity and null out fields the caller never touched.
    for (const [key, value] of Object.entries(draft)) {
      if (value !== undefined) (template as unknown as Record<string, unknown>)[key] = value;
    }
    return this.templates.save(template);
  }
}
