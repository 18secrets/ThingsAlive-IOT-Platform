import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two more widget types, `parameter_list` and `forecast_chart` (task QREC0b.1).
 *
 * `PageLayout1758200000000` wrote the type list as a literal so it would create the same
 * schema forever, and said adding a type is a new migration that alters its CHECK. This
 * is that migration, for all three layout tables at once. Literal again, for the same
 * reason; test/page-layout.spec.ts holds the database's list to the code's.
 *
 * Down restores the twelve. A layout row already using one of the two would make that
 * fail, which is right: removing a type a page is showing is a decision, not a rollback.
 */
const BEFORE = "'kpi_number', 'kpi_gauge', 'kpi_chart', 'signal_chart', 'readiness_list', 'schematic', "
  + "'alert_list', 'work_order_list', 'service_due', 'failure_modes', 'recommendations', 'machine_list'";
const AFTER = `${BEFORE}, 'parameter_list', 'forecast_chart'`;
const CHECKS: [string, string][] = [
  ['equipment_class_layout', 'ck_class_layout_widget_type'],
  ['client_equipment_class_layout', 'ck_client_layout_widget_type'],
  ['site_class_layout', 'ck_site_layout_widget_type'],
];

export class ParameterAndForecastWidgets1760000000000 implements MigrationInterface {
  name = 'ParameterAndForecastWidgets1760000000000';

  public async up(q: QueryRunner): Promise<void> {
    for (const [table, constraint] of CHECKS) await this.replace(q, table, constraint, AFTER);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [table, constraint] of CHECKS) await this.replace(q, table, constraint, BEFORE);
  }

  private async replace(q: QueryRunner, table: string, constraint: string, types: string): Promise<void> {
    await q.query(`ALTER TABLE "${table}" DROP CONSTRAINT "${constraint}"`);
    await q.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" CHECK ("widget_type" IN (${types}))`);
  }
}
