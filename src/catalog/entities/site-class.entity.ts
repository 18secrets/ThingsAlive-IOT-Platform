import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { WidgetSize, WidgetType } from '../layout/widget-types';
import { CatalogStatus } from './equipment-class-profile.entity';

/** The site class every plant without one of its own resolves to (seeded by the migration). */
export const DEFAULT_SITE_CLASS_SLUG = 'default';

/**
 * A kind of site — its page, its aggregate KPIs — as library content (task QREC0b,
 * D30 part 3). A site is not a bag of machines.
 *
 * Same lifecycle as `equipment_class_profile`. There are deliberately no authoring
 * routes: one row exists, nobody has asked for a second, and an authoring surface
 * with one row and no user is speculation. A second site class is its own task.
 */
@Entity('site_class')
export class SiteClass {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'int', default: 1 })
  version: number;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', default: 'draft' })
  status: CatalogStatus;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ name: 'created_by', type: 'text', nullable: true })
  createdBy: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/** A widget on a site page. The vocabulary is the equipment page's, with site-level
 * meaning — see WIDGET_SPECS for which types a site page may hold. */
@Entity('site_class_layout')
export class SiteClassLayout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'site_class_slug', type: 'text' })
  siteClassSlug: string;

  @Column({ name: 'class_version', type: 'int' })
  classVersion: number;

  @Column({ name: 'widget_type', type: 'text' })
  widgetType: WidgetType;

  @Column({ name: 'widget_key', type: 'text' })
  widgetKey: string;

  @Column({ name: 'bound_to', type: 'text', nullable: true })
  boundTo: string | null;

  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ type: 'int' })
  position: number;

  @Column({ type: 'text' })
  size: WidgetSize;

  /** How a bound site KPI combines its machines (task QPAGE1 §3). Present exactly
   * when `boundTo` is — `ck_site_layout_aggregate_declared`. */
  @Column({ type: 'text', nullable: true })
  aggregate: SiteAggregate | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

export const SITE_AGGREGATES = ['sum', 'avg', 'min', 'max', 'count'] as const;
export type SiteAggregate = (typeof SITE_AGGREGATES)[number];
