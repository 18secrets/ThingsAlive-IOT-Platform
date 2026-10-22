import { Pool } from 'pg';

const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:CdhlqhgUKSBzboKMRAItBDaYHJiMgYsI@crossover.proxy.rlwy.net:47609/railway';

async function main() {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    console.log('🚀 Starting Fleet & Platform Realism Migration...');
    await client.query('BEGIN');

    const TENANT_ID = 'demo-construction';

    // 1. Update Tenant Name
    console.log('🏢 1. Updating Tenant display name...');
    await client.query(`
      UPDATE tenant
      SET name = 'Apex Infrastructure & Mining Ltd.',
          updated_at = NOW()
      WHERE tenant_id = $1
    `, [TENANT_ID]);

    // 2. Update User Account
    console.log('👤 2. Updating App User profile...');
    await client.query(`
      UPDATE app_user
      SET full_name = 'Tapas Mohanty'
      WHERE email = 'tapas.m@thingsalive.io'
    `);

    // 3. Update Sites / Plants
    console.log('📍 3. Updating Plant & Yard names and descriptions...');
    await client.query(`
      UPDATE plant
      SET name = 'Pune Metro Expressway Package 04',
          description = 'Primary heavy civil casting yard & precast depot.',
          updated_at = NOW()
      WHERE tenant_id = $1 AND code = 'PUNE-01'
    `, [TENANT_ID]);

    await client.query(`
      UPDATE plant
      SET name = 'Talegaon Heavy Equipment Yard',
          description = 'Equipment reserve, mobilization & scheduled maintenance facility.',
          updated_at = NOW()
      WHERE tenant_id = $1 AND code = 'PUNE-02'
    `, [TENANT_ID]);

    // 4. Equipment Classes & Categories
    console.log('🚜 4. Updating & inserting Equipment Classes across multiple categories...');
    // A. Update existing demo-excavator metadata in equipment_class_profile
    await client.query(`
      UPDATE equipment_class_profile
      SET name = 'CAT & Komatsu Heavy Hydraulic Excavator (20T-35T)',
          category = 'Excavators & Earthmoving',
          description = '20-35 ton heavy crawler excavators for deep trenching, mass earthmoving, and site excavation.',
          status = 'published',
          updated_at = NOW()
      WHERE slug = 'demo-excavator'
    `);

    // B. Get existing signals, failure modes, default thresholds from client_equipment_class
    const [demoClassRow] = (await client.query(
      `SELECT expected_signals, failure_modes, default_thresholds FROM client_equipment_class WHERE slug = 'demo-excavator' AND tenant_id = $1`,
      [TENANT_ID]
    )).rows;

    const signalsJson = JSON.stringify(demoClassRow?.expected_signals || []);
    const failureModesJson = JSON.stringify(demoClassRow?.failure_modes || []);
    const defaultThresholdsJson = JSON.stringify(demoClassRow?.default_thresholds || {});

    // C. Upsert hydraulic-excavator into equipment_class_profile
    await client.query(`
      INSERT INTO equipment_class_profile (
        slug, version, name, description, category, expected_signals, failure_modes, default_thresholds, status, published_at, updated_at
      ) VALUES ('hydraulic-excavator', 1, 'CAT & Komatsu Heavy Hydraulic Excavator (20T-35T)',
                '20-35 ton heavy crawler excavators for deep trenching, mass earthmoving, and site excavation.',
                'Excavators & Earthmoving', $1::jsonb, $2::jsonb, $3::jsonb, 'published', NOW(), NOW())
      ON CONFLICT (slug, version) DO UPDATE
        SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category, status = 'published', updated_at = NOW()
    `, [signalsJson, failureModesJson, defaultThresholdsJson]);

    // Copy sensor requirements from demo-excavator to hydraulic-excavator
    await client.query(`
      INSERT INTO equipment_class_sensor_requirement (
        class_slug, class_version, measurement_role, component_scope, criticality, min_count,
        canonical_unit, enables, notes, source, stale_after_seconds, forecast_enabled, forecast_horizon_hours
      )
      SELECT 'hydraulic-excavator', class_version, measurement_role, component_scope, criticality, min_count,
             canonical_unit, enables, notes, source, stale_after_seconds, forecast_enabled, forecast_horizon_hours
        FROM equipment_class_sensor_requirement
       WHERE class_slug = 'demo-excavator'
      ON CONFLICT (class_slug, class_version, measurement_role, component_scope) DO NOTHING
    `);

    // D. Update client_equipment_class for demo-excavator -> hydraulic-excavator
    await client.query(`
      UPDATE client_equipment_class
      SET slug = 'hydraulic-excavator',
          name = 'CAT & Komatsu Heavy Hydraulic Excavator (20T-35T)',
          category = 'Excavators & Earthmoving',
          description = '20-35 ton heavy crawler excavators for deep trenching, mass earthmoving, and site excavation.',
          template_slug = 'hydraulic-excavator',
          updated_at = NOW()
      WHERE slug = 'demo-excavator' AND tenant_id = $1
    `, [TENANT_ID]);

    // Also leave a compatibility copy of demo-excavator in client_equipment_class if anything reads it
    await client.query(`
      INSERT INTO client_equipment_class (
        tenant_id, slug, name, description, category, expected_signals, failure_modes, default_thresholds,
        template_slug, template_version, template_checksum, copied_at, status, updated_by, created_at, updated_at
      )
      SELECT tenant_id, 'demo-excavator', name, description, category, expected_signals, failure_modes, default_thresholds,
             'demo-excavator', template_version, template_checksum, copied_at, status, updated_by, created_at, updated_at
        FROM client_equipment_class
       WHERE slug = 'hydraulic-excavator' AND tenant_id = $1
      ON CONFLICT (tenant_id, slug) DO UPDATE
        SET name = EXCLUDED.name, category = EXCLUDED.category, description = EXCLUDED.description
    `, [TENANT_ID]);

    // E. Ensure additional realistic categories exist in client_equipment_class
    const additionalClasses = [
      {
        slug: 'heavy-crawler-crane',
        name: 'Kobelco & Liebherr Hydraulic Crawler Crane (100 MT)',
        category: 'Lifting & Cranes',
        description: 'Heavy duty lattice-boom crawler cranes (70-100 MT) for heavy structural assembly and yard handling.',
      },
      {
        slug: 'prime-diesel-generator',
        name: 'Cummins Prime Power Diesel Generator (320 kVA)',
        category: 'Power Generation',
        description: 'Heavy duty 250-500 kVA prime continuous power diesel generators with electronic governors.',
      },
      {
        slug: 'screw-air-compressor',
        name: 'Kaeser Rotary Screw Industrial Compressor (500 CFM)',
        category: 'Pneumatic Systems',
        description: 'High-efficiency 400-500 CFM rotary screw air compressors for continuous site pneumatics.',
      },
      {
        slug: 'rotary-piling-rig',
        name: 'Bauer Hydraulic Rotary Piling Rig (264 kNm)',
        category: 'Foundation & Drilling',
        description: 'High-torque rotary piling and drilling rigs for bored piles and deep civil foundations.',
      },
      {
        slug: 'rock-tipper-truck',
        name: 'Heavy Duty Rock Body Tipper (35 MT)',
        category: 'Material Transport',
        description: 'Multi-axle 35 MT heavy rock tipper trucks for bulk overburden and muck transport.',
      },
    ];

    for (const cls of additionalClasses) {
      // Upsert into equipment_class_profile
      await client.query(`
        INSERT INTO equipment_class_profile (
          slug, version, name, description, category, expected_signals, failure_modes, default_thresholds, status, published_at, updated_at
        ) VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, 'published', NOW(), NOW())
        ON CONFLICT (slug, version) DO UPDATE
          SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category, status = 'published', updated_at = NOW()
      `, [cls.slug, cls.name, cls.description, cls.category, signalsJson, failureModesJson, defaultThresholdsJson]);

      // Copy sensor requirements
      await client.query(`
        INSERT INTO equipment_class_sensor_requirement (
          class_slug, class_version, measurement_role, component_scope, criticality, min_count,
          canonical_unit, enables, notes, source, stale_after_seconds, forecast_enabled, forecast_horizon_hours
        )
        SELECT $1, class_version, measurement_role, component_scope, criticality, min_count,
               canonical_unit, enables, notes, source, stale_after_seconds, forecast_enabled, forecast_horizon_hours
          FROM equipment_class_sensor_requirement
         WHERE class_slug = 'hydraulic-excavator'
        ON CONFLICT (class_slug, class_version, measurement_role, component_scope) DO NOTHING
      `, [cls.slug]);

      // Upsert into client_equipment_class
      await client.query(`
        INSERT INTO client_equipment_class (
          tenant_id, slug, name, description, category, expected_signals, failure_modes, default_thresholds,
          template_slug, template_version, template_checksum, copied_at, status, updated_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $2, 1, 'actual-catalog-seed', NOW(), 'active', 'system', NOW(), NOW())
        ON CONFLICT (tenant_id, slug) DO UPDATE
          SET name = EXCLUDED.name, description = EXCLUDED.description, category = EXCLUDED.category, status = 'active', updated_at = NOW()
      `, [TENANT_ID, cls.slug, cls.name, cls.description, cls.category, signalsJson, failureModesJson, defaultThresholdsJson]);
    }

    // 5. Update client_equipment_class_layout
    console.log('📊 5. Updating layout widgets and copying to all new classes...');
    await client.query(`
      UPDATE client_equipment_class_layout
      SET client_equipment_class_slug = 'hydraulic-excavator'
      WHERE client_equipment_class_slug = 'demo-excavator' AND tenant_id = $1
    `, [TENANT_ID]);

    // Also leave layout rows for demo-excavator for backward compatibility
    await client.query(`
      INSERT INTO client_equipment_class_layout (
        tenant_id, client_equipment_class_slug, widget_type, widget_key, bound_to, title, position, size, hidden, position_custom
      )
      SELECT tenant_id, 'demo-excavator', widget_type, widget_key, bound_to, title, position, size, hidden, position_custom
        FROM client_equipment_class_layout
       WHERE tenant_id = $1 AND client_equipment_class_slug = 'hydraulic-excavator'
      ON CONFLICT (tenant_id, client_equipment_class_slug, widget_key) DO NOTHING
    `, [TENANT_ID]);

    // Copy layout to additional classes so all machines have full widgets
    for (const cls of additionalClasses) {
      await client.query(`
        INSERT INTO client_equipment_class_layout (
          tenant_id, client_equipment_class_slug, widget_type, widget_key, bound_to, title, position, size, hidden, position_custom
        )
        SELECT $1, $2, widget_type, widget_key, bound_to, title, position, size, hidden, position_custom
          FROM client_equipment_class_layout
         WHERE tenant_id = $1 AND client_equipment_class_slug = 'hydraulic-excavator'
        ON CONFLICT (tenant_id, client_equipment_class_slug, widget_key) DO NOTHING
      `, [TENANT_ID, cls.slug]);
    }

    // 5.1 Copy Formulas to all classes
    console.log('📐 5.1 Copying equipment_class_formula and client_formula to all classes...');
    const allTargetClasses = ['hydraulic-excavator', ...additionalClasses.map((c) => c.slug)];
    for (const cls of allTargetClasses) {
      await client.query(`
        INSERT INTO equipment_class_formula (
          class_slug, class_version, formula_key, kind, expression, inputs, output_unit, basis,
          "references", status, approved_by, approved_at, version, compiled_plan, compiled_at,
          compiler_version, source, import_batch_id, named_formula_slug, named_formula_version,
          bindings, result_kind, display_unit, display_format, target_value, target_min, target_max,
          target_direction, comparison_basis, aggregation_window, chart_type, result_unit,
          required_signals, required_parameters, created_at
        )
        SELECT $1, f.class_version, f.formula_key, f.kind, f.expression, f.inputs, f.output_unit, f.basis,
               f."references", f.status, f.approved_by, f.approved_at, f.version, f.compiled_plan, f.compiled_at,
               f.compiler_version, f.source, f.import_batch_id, f.named_formula_slug, f.named_formula_version,
               f.bindings, f.result_kind, f.display_unit, f.display_format, f.target_value, f.target_min, f.target_max,
               f.target_direction, f.comparison_basis, f.aggregation_window, f.chart_type, f.result_unit,
               f.required_signals, f.required_parameters, f.created_at
          FROM equipment_class_formula f
         WHERE f.class_slug = 'demo-excavator'
           AND NOT EXISTS (
             SELECT 1 FROM equipment_class_formula ex
              WHERE ex.class_slug = $1
                AND ex.formula_key = f.formula_key
                AND ex.class_version = f.class_version
           )
      `, [cls]);

      await client.query(`
        INSERT INTO client_formula (
          tenant_id, client_equipment_class_slug, formula_key, kind, expression,
          compiled_plan, compiled_at, compiler_version, result_unit, required_signals,
          required_parameters, named_formula_slug, named_formula_version, bindings,
          result_kind, display_unit, display_format, target_value, target_min, target_max,
          target_direction, comparison_basis, aggregation_window, chart_type,
          template_version, copied_at, status, source, proposal_id, updated_by, created_at, updated_at
        )
        SELECT f.tenant_id, $1, f.formula_key, f.kind, f.expression,
               f.compiled_plan, f.compiled_at, f.compiler_version, f.result_unit, f.required_signals,
               f.required_parameters, f.named_formula_slug, f.named_formula_version, f.bindings,
               f.result_kind, f.display_unit, f.display_format, f.target_value, f.target_min, f.target_max,
               f.target_direction, f.comparison_basis, f.aggregation_window, f.chart_type,
               f.template_version, f.copied_at, f.status, f.source, f.proposal_id, f.updated_by, f.created_at, f.updated_at
          FROM client_formula f
         WHERE f.tenant_id = $2
           AND f.client_equipment_class_slug = 'demo-excavator'
           AND NOT EXISTS (
             SELECT 1 FROM client_formula ex
              WHERE ex.tenant_id = $2
                AND ex.client_equipment_class_slug = $1
                AND ex.formula_key = f.formula_key
           )
      `, [cls, TENANT_ID]);
    }

    // 6. Causal Chains
    console.log('🔗 6. Updating causal chains...');
    await client.query(`
      UPDATE causal_chain
      SET slug = 'cooling-circuit-chain',
          name = 'Coolant & Heat Dissipation Causal Chain',
          equipment_class_slug = 'hydraulic-excavator'
      WHERE slug = 'demo-excavator-cooling-chain'
    `);

    for (const cls of ['heavy-crawler-crane', 'prime-diesel-generator', 'screw-air-compressor', 'demo-excavator']) {
      await client.query(`
        INSERT INTO causal_chain (
          slug, version, equipment_class_slug, name, description, outcome, nodes, status, published_at, created_at
        )
        SELECT $1 || '-cooling-chain', version, $1, name, description, outcome, nodes, status, published_at, created_at
          FROM causal_chain
         WHERE slug = 'cooling-circuit-chain'
        ON CONFLICT (slug, version) DO NOTHING
      `, [cls]);
    }

    // 7. Scenarios and Slugs
    console.log('⚡ 7. Renaming scenario slugs and copying across classes...');
    // A. Rename existing scenarios on hydraulic-excavator
    await client.query(`
      UPDATE client_scenario
      SET slug = replace(slug, 'demo-excavator-', ''),
          client_equipment_class_slug = 'hydraulic-excavator',
          updated_at = NOW()
      WHERE tenant_id = $1 AND slug LIKE 'demo-excavator-%'
    `, [TENANT_ID]);

    // B. Rename in equipment_scenario
    await client.query(`
      UPDATE equipment_scenario
      SET client_scenario_slug = replace(client_scenario_slug, 'demo-excavator-', '')
      WHERE tenant_id = $1 AND client_scenario_slug LIKE 'demo-excavator-%'
    `, [TENANT_ID]);

    // C. Rename in prediction table and partitions
    await client.query(`
      UPDATE prediction
      SET client_scenario_slug = replace(client_scenario_slug, 'demo-excavator-', '')
      WHERE tenant_id = $1 AND client_scenario_slug LIKE 'demo-excavator-%'
    `, [TENANT_ID]);

    // D. Add scenarios for heavy-crawler-crane, prime-diesel-generator, screw-air-compressor
    for (const cls of ['heavy-crawler-crane', 'prime-diesel-generator', 'screw-air-compressor']) {
      const scenariosToCopy = [
        { suffix: 'coolant-drift', name: 'Coolant Thermal Runaway Drift', sev: 'high' },
        { suffix: 'oil-pressure', name: 'Engine Lubrication & Low Oil Pressure', sev: 'critical' },
        { suffix: 'engine-stress', name: 'High Engine Stress & Duty Fatigue', sev: 'high' },
        { suffix: 'hydraulic-heat', name: 'Hydraulic Circuit Heat Soak', sev: 'medium' },
        { suffix: 'fuel-burn', name: 'Excessive Fuel Consumption Rate', sev: 'medium' },
      ];
      for (const sc of scenariosToCopy) {
        const scenarioSlug = `${cls}-${sc.suffix}`;
        await client.query(`
          INSERT INTO client_scenario (
            tenant_id, slug, client_equipment_class_slug, name, description, severity, tier,
            required_signals, minimum_history_days, parameters, enabled, template_slug, template_version,
            template_checksum, copied_at, status, updated_by, created_at, updated_at
          )
          SELECT $1, $2, $3, $4, description, severity, tier,
                 required_signals, minimum_history_days, parameters, enabled, template_slug, template_version,
                 template_checksum, copied_at, status, updated_by, created_at, updated_at
            FROM client_scenario
           WHERE tenant_id = $1 AND slug = $5
          ON CONFLICT (tenant_id, slug) DO UPDATE
            SET name = EXCLUDED.name, client_equipment_class_slug = EXCLUDED.client_equipment_class_slug
        `, [TENANT_ID, scenarioSlug, cls, sc.name, sc.suffix]);
      }
    }

    // 8. Update Equipment Profiles
    console.log('🏗️ 8. Updating Equipment Fleet profiles to realistic machines & categories...');
    const p1SiteRes = await client.query(`SELECT id FROM plant WHERE code = 'PUNE-01' AND tenant_id = $1`, [TENANT_ID]);
    const p2SiteRes = await client.query(`SELECT id FROM plant WHERE code = 'PUNE-02' AND tenant_id = $1`, [TENANT_ID]);
    const mainPlantId = p1SiteRes.rows[0]?.id;
    const yardPlantId = p2SiteRes.rows[0]?.id;

    const equipmentUpdates = [
      {
        externalId: 'EX-01',
        name: 'CAT 320D3 Heavy Hydraulic Excavator (Unit 01)',
        classSlug: 'hydraulic-excavator',
        mfr: 'Caterpillar',
        model: '320D3',
        serial: 'CAT0320D3K89201',
        desc: 'Primary 20-ton hydraulic crawler excavator operating on corridor trenching & mass earthwork.',
        plantId: mainPlantId,
        category: 'Excavators & Earthmoving',
      },
      {
        externalId: 'EX-02',
        name: 'Komatsu PC210-10M0 Excavator (Unit 02)',
        classSlug: 'hydraulic-excavator',
        mfr: 'Komatsu',
        model: 'PC210-10M0',
        serial: 'KMTPC210M078342',
        desc: '21-ton hydraulic excavator deployed for continuous material excavation and loading.',
        plantId: mainPlantId,
        category: 'Excavators & Earthmoving',
      },
      {
        externalId: 'EX-03',
        name: 'Hitachi ZX200-5G Heavy Excavator (Unit 03)',
        classSlug: 'hydraulic-excavator',
        mfr: 'Hitachi',
        model: 'ZX200-5G',
        serial: 'HITZX2005G44910',
        desc: 'Heavy duty earthmoving crawler excavator operating under intense heavy duty cycles.',
        plantId: mainPlantId,
        category: 'Excavators & Earthmoving',
      },
      {
        externalId: 'EX-04',
        name: 'Kobelco CKL-1000i Heavy Crawler Crane (Unit 04)',
        classSlug: 'heavy-crawler-crane',
        mfr: 'Kobelco',
        model: 'CKL-1000i',
        serial: 'KOBCKL10007621',
        desc: '100 MT lattice-boom crawler crane stationed at Talegaon Depot for scheduled boom overhaul.',
        plantId: yardPlantId,
        category: 'Lifting & Cranes',
      },
      {
        externalId: 'EX-05',
        name: 'Cummins C320D5P Diesel Generator (Unit 05)',
        classSlug: 'prime-diesel-generator',
        mfr: 'Cummins',
        model: 'C320D5P',
        serial: 'CUMGEN320D9102',
        desc: '320 kVA prime-power containerized generator supplying site substation power.',
        plantId: mainPlantId,
        category: 'Power Generation',
      },
      {
        externalId: 'EX-06',
        name: 'Kaeser CSDX 162 Screw Compressor (Unit 06)',
        classSlug: 'screw-air-compressor',
        mfr: 'Kaeser',
        model: 'CSDX 162',
        serial: 'KAECSDX162445',
        desc: 'Continuous-duty 500 CFM rotary screw air compressor powering pneumatic drilling tools.',
        plantId: mainPlantId,
        category: 'Pneumatic Systems',
      },
    ];

    for (const eq of equipmentUpdates) {
      await client.query(`
        UPDATE equipment_profile
        SET name = $1,
            equipment_class_slug = $2,
            manufacturer = $3,
            model_number = $4,
            serial_number = $5,
            description = $6,
            plant_id = $7,
            updated_at = NOW()
        WHERE external_id = $8 AND tenant_id = $9
      `, [eq.name, eq.classSlug, eq.mfr, eq.model, eq.serial, eq.desc, eq.plantId, eq.externalId, TENANT_ID]);

      await client.query(`
        UPDATE equipment_projection
        SET name = $1,
            class_id = $2,
            category = $3,
            plant_external_id = 'PUNE-01'
        WHERE external_id = $4 AND tenant_id = $5
      `, [eq.name, eq.classSlug, eq.category, eq.externalId, TENANT_ID]);
    }

    // 9. Update Device Projections
    console.log('📡 9. Updating Gateway / Telematics device descriptions...');
    const deviceNames: Record<string, string> = {
      'EX-01': 'Edge Telematics Gateway (CAT-320D3)',
      'EX-02': 'Edge Telematics Gateway (KOM-PC210)',
      'EX-03': 'Edge Telematics Gateway (HIT-ZX200)',
      'EX-04': 'Edge Telematics Gateway (KOB-CKL1000)',
      'EX-05': 'Edge Telematics Gateway (CUM-C320D5P)',
      'EX-06': 'Edge Telematics Gateway (KAE-CSDX162)',
    };
    for (const [eqId, devName] of Object.entries(deviceNames)) {
      await client.query(`
        UPDATE device_projection
        SET name = $1
        WHERE equipment_external_id = $2 AND tenant_id = $3
      `, [devName, eqId, TENANT_ID]);
    }

    await client.query('COMMIT');
    console.log('✅ Successfully applied all enterprise realism updates!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Failed to update database:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
