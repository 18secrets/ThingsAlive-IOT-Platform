import {
  compileClassFormulas, compileFormula, CompileFormulaInput, DeclaredSignal, FormulaCompileError,
} from '../src/catalog/formula/formula-compiler';
import { CONTENT_SHEETS } from '../src/catalog-import/template-schema';

/**
 * The formula compiler (tasks QCE1, QCE1.1) — the parser, the operator registry,
 * the unit/kind inference that turns an expression into a `compiled_plan` (or
 * refuses it), and `#formula_key` composition across a class's formulas. Follows
 * QL1's pattern: every refusal gets a test that attempts it, not a test that
 * asserts a rule exists in the abstract.
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

    it('7. refuses "+" or "-" between two named quantities of incompatible units', () => {
      // Both operands are calls, not literals — a bare number was never one of
      // these (task QCE1.1); this is the refusal that must survive it.
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

    it('12. refuses fraction_within whose bounds carry a different unit from the series (task QCE1.1: '
      + 'literal bounds now pass — the mismatch must come from a signal-bearing bound)', () => {
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

    it('18. refuses a #ref to a formula key that does not exist in the class', () => {
      expect(() => compile('#does_not_exist + 1'))
        .toThrow(/references formula "#does_not_exist", which does not exist in class "diesel-generator"/);
    });

    it('19. refuses a dependency cycle, naming it', () => {
      const results = compileClassFormulas({
        classSlug: 'diesel-generator',
        expectedSignals: SIGNALS,
        formulas: [
          { formulaKey: 'a', expression: '#b + 1' },
          { formulaKey: 'b', expression: '#a + 1' },
        ],
      });
      expect(results.get('a')!.status).toBe('error');
      expect(results.get('b')!.status).toBe('error');
      const aError = (results.get('a') as { status: 'error'; error: FormulaCompileError }).error;
      expect(aError.message).toMatch(/participates in a dependency cycle \(a -> b -> a\)/);
    });

    it('20. refuses a #ref to a formula that itself failed to compile, naming both', () => {
      const results = compileClassFormulas({
        classSlug: 'diesel-generator',
        expectedSignals: SIGNALS,
        formulas: [
          { formulaKey: 'bad', expression: 'avg(not_a_declared_signal)' },
          { formulaKey: 'good', expression: '#bad + 1' },
        ],
      });
      expect(results.get('bad')!.status).toBe('error');
      const goodResult = results.get('good') as { status: 'error'; error: FormulaCompileError };
      expect(goodResult.status).toBe('error');
      expect(goodResult.error.message).toMatch(/formula "good"/);
      expect(goodResult.error.message).toMatch(/references formula "#bad", which failed to compile/);
      expect(goodResult.error.message).toMatch(/formula "bad"/);
    });

    it('21a. refuses composition more than 5 levels deep, naming the depth', () => {
      const formulas = [{ formulaKey: 'f1', expression: 'avg(coolant_temp_c)' }];
      for (let i = 2; i <= 7; i += 1) {
        formulas.push({ formulaKey: `f${i}`, expression: `#f${i - 1} + 1` });
      }
      const results = compileClassFormulas({ classSlug: 'diesel-generator', expectedSignals: SIGNALS, formulas });
      expect(results.get('f6')!.status).toBe('ok');
      const f7 = results.get('f7') as { status: 'error'; error: FormulaCompileError };
      expect(f7.status).toBe('error');
      expect(f7.error.message).toMatch(/composes formulas 6 levels deep; the limit is 5/);
    });

    it('21b. refuses once the #ref-expanded tree exceeds 200 nodes, even though every '
      + 'written formula and the composition chain (depth 5) are both individually within limits', () => {
      // Each g(n) references g(n-1) TWICE, so its expanded node count roughly
      // doubles at every hop — an untrusted spreadsheet must not be able to build a
      // 200-node bomb out of a handful of small formulas chained together.
      const formulas = [{ formulaKey: 'g1', expression: '1+1+1' }];
      for (let i = 2; i <= 6; i += 1) {
        formulas.push({ formulaKey: `g${i}`, expression: `#g${i - 1} + #g${i - 1}` });
      }
      const results = compileClassFormulas({ classSlug: 'diesel-generator', expectedSignals: SIGNALS, formulas });
      expect(results.get('g5')!.status).toBe('ok');
      const g6 = results.get('g6') as { status: 'error'; error: FormulaCompileError };
      expect(g6.status).toBe('error');
      expect(g6.error.message).toMatch(/expands to more than 200 nodes/);
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

    // ------------------------------------------ task QCE1.1: literal unit polymorphism

    it('a numeric literal adopts the other operand\'s unit in "-": "105 - coolant_temp_c" compiles to degC', () => {
      const result = compile('105 - coolant_temp_c');
      expect(result.resultUnit).toBe('degC');
      expect(result.resultKind).toBe('series');
    });

    it('a numeric literal adopts the other operand\'s unit in "+"', () => {
      const result = compile('coolant_temp_c + 5');
      expect(result.resultUnit).toBe('degC');
    });

    it('two literals combined in "+" stay dimensionless', () => {
      const result = compile('105 + 3');
      expect(result.resultUnit).toBe('dimensionless');
    });

    it('a literal stays dimensionless (the identity) in "*" and "/", never adopting a unit of its own', () => {
      expect(compile('coolant_temp_c * 2').resultUnit).toBe('degC');
      expect(compile('coolant_temp_c / 2').resultUnit).toBe('degC');
    });

    it('fraction_within accepts literal bounds, which adopt the series\' unit', () => {
      const result = compile('fraction_within(coolant_temp_c, 80, 100)');
      expect(result.resultUnit).toBe('dimensionless');
      expect(result.resultKind).toBe('scalar');
    });

    it('a computed sub-expression that happens to be constant is not treated as a literal', () => {
      // Narrow, deliberate interpretation: "a numeric literal" is the grammar's own
      // `number` production, not anything that could be constant-folded to one.
      expect(() => compile('(1 + 1) + avg(coolant_temp_c)'))
        .toThrow(/combines "dimensionless" and "degC", which are different units/);
    });

    // ------------------------------------------------- task QCE1.1: #formula_key composition

    it('a #ref reuses the referenced formula\'s kind and unit, without re-inferring it', () => {
      const results = compileClassFormulas({
        classSlug: 'diesel-generator',
        expectedSignals: SIGNALS,
        formulas: [
          { formulaKey: 'base_temp', expression: 'avg(coolant_temp_c)' },
          { formulaKey: 'derived', expression: '#base_temp + 10' },
        ],
      });
      const base = results.get('base_temp') as { status: 'ok'; compiled: ReturnType<typeof compileFormula> };
      const derived = results.get('derived') as { status: 'ok'; compiled: ReturnType<typeof compileFormula> };
      expect(base.status).toBe('ok');
      expect(derived.status).toBe('ok');
      expect(derived.compiled.resultUnit).toBe(base.compiled.resultUnit);
      expect(derived.compiled.resultKind).toBe(base.compiled.resultKind);
      expect(derived.compiled.plan).toMatchObject({
        type: 'binary', op: '+',
        left: { type: 'formula_ref', formulaKey: 'base_temp', kind: 'scalar', unit: 'degC' },
      });
    });

    it('required_signals and required_formulas are the transitive closure through #ref', () => {
      const results = compileClassFormulas({
        classSlug: 'diesel-generator',
        expectedSignals: SIGNALS,
        formulas: [
          { formulaKey: 'base_temp', expression: 'avg(coolant_temp_c)' },
          { formulaKey: 'derived', expression: '#base_temp + 10' },
          { formulaKey: 'twice_derived', expression: '#derived + #derived' },
        ],
      });
      const twice = (results.get('twice_derived') as { status: 'ok'; compiled: ReturnType<typeof compileFormula> }).compiled;
      expect(twice.requiredSignals).toEqual(['coolant_temp_c']);
      expect(twice.requiredFormulas).toEqual(['base_temp', 'derived']);
    });

    it('compiles a class\'s formulas in dependency order regardless of the order given', () => {
      const results = compileClassFormulas({
        classSlug: 'diesel-generator',
        expectedSignals: SIGNALS,
        formulas: [
          // 'derived' listed before its own dependency 'base_temp'.
          { formulaKey: 'derived', expression: '#base_temp + 10' },
          { formulaKey: 'base_temp', expression: 'avg(coolant_temp_c)' },
        ],
      });
      expect(results.get('base_temp')!.status).toBe('ok');
      expect(results.get('derived')!.status).toBe('ok');
    });

    it('compileFormula resolves #ref against explicitly supplied siblingFormulas', () => {
      const result = compileFormula({
        formulaKey: 'derived', expression: '#base_temp + 10', classSlug: 'diesel-generator', expectedSignals: SIGNALS,
        siblingFormulas: [{ formulaKey: 'base_temp', expression: 'avg(coolant_temp_c)' }],
      });
      expect(result.resultUnit).toBe('degC');
      expect(result.requiredSignals).toEqual(['coolant_temp_c']);
      expect(result.requiredFormulas).toEqual(['base_temp']);
    });
  });

  describe('the shipped template', () => {
    it("17. every formula in the shipped catalog-import template compiles", () => {
      // Read from template-schema.ts itself, not a copy of its content — the same
      // reason catalog-import-apply.spec.ts's own template test builds the exact
      // bytes `npm run catalog:template` writes rather than a hand-built fixture.
      // `max(coolant_temp_c)` shipped for a while in QCE1, after `105 -
      // coolant_temp_c` looked plausible and failed exactly this check under
      // QCE1's stricter unit rule; QCE1.1's literal unit polymorphism restores it,
      // and this is what keeps that restoration honest.
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
