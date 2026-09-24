import { compileFormula, CompileFormulaInput, FormulaCompileError } from '../src/catalog/formula/formula-compiler';
import { DeclaredSignal } from '../src/catalog/formula/formula-compiler';
import { CONTENT_SHEETS } from '../src/catalog-import/template-schema';

/**
 * The formula compiler (task QCE1) — the parser, the operator registry and the
 * unit/kind inference that turns an expression into a `compiled_plan`, or refuses
 * it. Follows QL1's pattern: every refusal gets a test that attempts it, not a test
 * that asserts a rule exists in the abstract.
 */
describe('formula compiler', () => {
  const SIGNALS: DeclaredSignal[] = [
    { signal: 'active_power', unit: 'MW' },
    { signal: 'coolant_temp_c', unit: 'degC' },
    { signal: 'oil_pressure_kpa', unit: 'kPa' },
    { signal: 'vibration_mm_s', unit: 'mm/s' },
    { signal: 'fuel_level_pct', unit: '%' },
    { signal: 'unresolved_unit_signal', unit: null },
  ];

  const compile = (expression: string, over: Partial<CompileFormulaInput> = {}) => compileFormula({
    formulaKey: 'test_formula', expression, classSlug: 'diesel-generator', expectedSignals: SIGNALS,
    ...over,
  });

  describe('refusals', () => {
    it('1. refuses an unknown function name', () => {
      expect(() => compile('nonsense(coolant_temp_c)')).toThrow(/unknown function "nonsense"/);
    });

    it('2. refuses the wrong arity for a known function', () => {
      expect(() => compile('avg(coolant_temp_c, oil_pressure_kpa)'))
        .toThrow(/"avg" with 2 argument\(s\); it takes 1/);
      expect(() => compile('fraction_within(coolant_temp_c, 1)'))
        .toThrow(/"fraction_within" with 2 argument\(s\); it takes 3/);
    });

    it('3. refuses a signal not present in the class\'s expected_signals', () => {
      expect(() => compile('avg(not_a_declared_signal)'))
        .toThrow(/"not_a_declared_signal", which is not one of class "diesel-generator"'s expected_signals/);
    });

    it('4. refuses a signal whose canonical unit cannot be resolved', () => {
      expect(() => compile('avg(unresolved_unit_signal)'))
        .toThrow(/"unresolved_unit_signal", whose canonical unit cannot be resolved/);
    });

    it('5. refuses unbalanced parentheses and a trailing operator, naming the character position', () => {
      expect(() => compile('avg(coolant_temp_c')).toThrow(/expected \)/);
      expect(() => compile('avg(coolant_temp_c))')).toThrow(/position/);
      expect(() => compile('avg(coolant_temp_c) +')).toThrow(/end of expression.*position/);
    });

    it('6. refuses division by a literal zero', () => {
      expect(() => compile('avg(coolant_temp_c) / 0')).toThrow(/divides by the literal 0/);
    });

    it('7. refuses "+" or "-" across two different units', () => {
      expect(() => compile('avg(coolant_temp_c) + avg(oil_pressure_kpa)'))
        .toThrow(/"\+" combines "degC" and "kPa", which are different units/);
      expect(() => compile('avg(coolant_temp_c) - avg(oil_pressure_kpa)'))
        .toThrow(/"-" combines "degC" and "kPa", which are different units/);
    });

    it('8. refuses when the inferred result unit does not match the declared display_unit', () => {
      expect(() => compile('avg(coolant_temp_c)', { declaredDisplayUnit: 'kPa' }))
        .toThrow(/declared display_unit "kPa" does not match the inferred unit "degC"/);
    });

    it('9. refuses when the inferred result_kind does not match the declared one', () => {
      expect(() => compile('coolant_temp_c', { declaredResultKind: 'scalar' }))
        .toThrow(/declared result_kind "scalar" does not match the inferred kind "series"/);
      expect(() => compile('avg(coolant_temp_c)', { declaredResultKind: 'series' }))
        .toThrow(/declared result_kind "series" does not match the inferred kind "scalar"/);
    });

    it('10. refuses an aggregation nested inside an aggregation', () => {
      expect(() => compile('avg(avg(coolant_temp_c))'))
        .toThrow(/"avg" with argument 1 as scalar; it takes series/);
    });

    it('11. refuses an aggregation function given a scalar argument', () => {
      expect(() => compile('avg(2 + 3)'))
        .toThrow(/"avg" with argument 1 as scalar; it takes series/);
    });

    it('12. refuses fraction_within whose bounds do not carry the series\' unit', () => {
      // Bare numbers are dimensionless (section 3's own rule) — against a degC
      // series, that is already a mismatch, which is the natural way this is hit.
      expect(() => compile('fraction_within(coolant_temp_c, 1, 2)'))
        .toThrow(/"fraction_within" with bounds \("dimensionless", "dimensionless"\) that do not carry the series' unit \("degC"\)/);
    });

    it('12b. refuses fraction_within whose bounds carry a different unit from each other', () => {
      expect(() => compile('fraction_within(coolant_temp_c, avg(oil_pressure_kpa), avg(coolant_temp_c))'))
        .toThrow(/"fraction_within" with bounds \("kPa", "degC"\) that do not carry the series' unit \("degC"\)/);
    });

    it('13. refuses an expression exceeding 200 nodes', () => {
      const deep = Array.from({ length: 205 }, () => '1').join('+');
      expect(() => compile(deep)).toThrow(/exceeds 200 nodes/);
    });

    it('13b. refuses an expression exceeding depth 20', () => {
      const nested = '-'.repeat(25) + '1';
      expect(() => compile(nested)).toThrow(/exceeds depth 20/);
    });
  });

  describe('correct behaviour', () => {
    it('15. integrate over a power signal in MW yields a unit of MWh', () => {
      const result = compile('integrate(active_power)');
      expect(result.resultUnit).toBe('MWh');
      expect(result.resultKind).toBe('scalar');
      expect(result.requiredSignals).toEqual(['active_power']);
    });

    it('16. the same expression compiled twice produces byte-identical compiled_plan', () => {
      const a = compile('integrate(active_power) / fraction_within(coolant_temp_c, avg(coolant_temp_c), avg(coolant_temp_c))');
      const b = compile('integrate(active_power) / fraction_within(coolant_temp_c, avg(coolant_temp_c), avg(coolant_temp_c))');
      expect(JSON.stringify(a.plan)).toBe(JSON.stringify(b.plan));
      expect(a).toEqual(b);
    });

    it('derives required_signals and required_parameters, never author-supplied', () => {
      const result = compile('avg(coolant_temp_c) * @derate_factor');
      expect(result.requiredSignals).toEqual(['coolant_temp_c']);
      expect(result.requiredParameters).toEqual(['derate_factor']);
    });

    it('a param is scalar and dimensionless', () => {
      const result = compile('@derate_factor');
      expect(result.resultKind).toBe('scalar');
      expect(result.resultUnit).toBe('dimensionless');
    });

    it('rate divides by hour', () => {
      const result = compile('rate(fuel_level_pct)');
      expect(result.resultUnit).toBe('%/h');
    });

    it('count is dimensionless regardless of the series', () => {
      expect(compile('count(coolant_temp_c)').resultUnit).toBe('dimensionless');
    });

    it('every compiled node carries kind and unit', () => {
      const result = compile('avg(coolant_temp_c)');
      expect(result.plan).toMatchObject({ type: 'call', kind: 'scalar', unit: 'degC', name: 'avg' });
      expect((result.plan as any).args[0]).toMatchObject({ type: 'signal', kind: 'series', unit: 'degC' });
    });

    it('accepts every error thrown as a FormulaCompileError', () => {
      try {
        compile('nonsense(1)');
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FormulaCompileError);
        expect((err as Error).message).toMatch(/^formula "test_formula":/);
      }
    });
  });

  describe('the shipped template', () => {
    it("17. every formula in the shipped catalog-import template compiles", () => {
      // Read from template-schema.ts itself, not a copy of its content — the same
      // reason catalog-import-apply.spec.ts's own template test builds the exact
      // bytes `npm run catalog:template` writes rather than a hand-built fixture.
      // `105 - coolant_temp_c` looked plausible and failed exactly this check once
      // (see template-schema.ts's formula example comment); this is what makes that
      // stay caught.
      const signalSheet = CONTENT_SHEETS.find((s) => s.sheet === 'signal')!;
      const formulaSheet = CONTENT_SHEETS.find((s) => s.sheet === 'formula')!;
      const classSlug = String(signalSheet.example.class_slug);
      expect(String(formulaSheet.example.class_slug)).toBe(classSlug);

      const expectedSignals: DeclaredSignal[] = [
        { signal: String(signalSheet.example.signal), unit: String(signalSheet.example.unit) },
      ];

      expect(() => compileFormula({
        formulaKey: String(formulaSheet.example.formula_key),
        expression: String(formulaSheet.example.expression),
        classSlug,
        expectedSignals,
      })).not.toThrow();
    });
  });
});
