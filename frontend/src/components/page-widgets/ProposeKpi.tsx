import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import {
  ApiError, NamedFormula, apiGetMyCatalogEquipmentClass, apiListEquipmentKpis, apiListPublishedNamedFormulas, apiProposeKpi,
  needsInput,
} from '../../lib/api';

type Intent = 'bind-named-formula' | 'ratio-kpis';

/**
 * Proposes a KPI for this machine (QGEN2) from one of two closed intents: bind a
 * published library formula, or divide one of the machine's KPIs by another. It
 * becomes a draft for the super admin to approve, never a KPI directly. When a formula
 * input could be several of the class's signals, the generator answers which inputs are
 * open, and the form asks for those and sends the same selection again.
 */
export const ProposeKpi: React.FC<{ sourceSystem: string; externalId: string; classSlug: string }> = ({ sourceSystem, externalId, classSlug }) => {
  const { t } = useTranslation('drafts');
  const navigate = useNavigate();
  const [intent, setIntent] = useState<Intent>('bind-named-formula');
  const [formulas, setFormulas] = useState<NamedFormula[]>([]);
  const [kpiKeys, setKpiKeys] = useState<string[]>([]);
  const [signals, setSignals] = useState<string[]>([]);
  const [formula, setFormula] = useState<string | null>(null);
  const [numerator, setNumerator] = useState<string | null>(null);
  const [denominator, setDenominator] = useState<string | null>(null);
  // Inputs the generator could not settle on its own: role -> what it said, and the choice made.
  const [openRoles, setOpenRoles] = useState<{ role: string; detail: string }[]>([]);
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiListPublishedNamedFormulas().then(setFormulas).catch(() => setFormulas([]));
    apiListEquipmentKpis(sourceSystem, externalId).then((k) => setKpiKeys(k.map((x) => x.formulaKey))).catch(() => setKpiKeys([]));
    apiGetMyCatalogEquipmentClass(classSlug).then((c) => setSignals(c.expectedSignals.map((s) => s.signal))).catch(() => setSignals([]));
  }, [sourceSystem, externalId, classSlug]);

  // A different formula is a different set of inputs.
  useEffect(() => { setOpenRoles([]); setBindings({}); setMissing([]); }, [formula, intent]);

  const ready = intent === 'bind-named-formula' ? !!formula && openRoles.every((r) => bindings[r.role])
    : !!numerator && !!denominator && numerator !== denominator;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    setMissing([]);
    try {
      const seed = intent === 'bind-named-formula'
        ? { intent, namedFormulaSlug: formula, bindings: Object.entries(bindings).map(([role, signal]) => ({ role, signal })) }
        : { intent, formulaKeys: [numerator, denominator] };
      const result = await apiProposeKpi(sourceSystem, externalId, {
        ...seed, idempotencyKey: `kpi-${externalId}-${JSON.stringify(seed)}-${Date.now()}`,
      });
      if (!needsInput(result)) {
        navigate(`/drafts?id=${result.id}`);
        return;
      }
      const roles = result.missing.filter((m) => m.field.startsWith('bindings.'));
      setOpenRoles((prev) => {
        const known = new Map(prev.map((r) => [r.role, r]));
        for (const m of roles) known.set(m.field.slice('bindings.'.length), { role: m.field.slice('bindings.'.length), detail: m.detail });
        return [...known.values()];
      });
      setMissing(result.missing.filter((m) => !m.field.startsWith('bindings.')).map((m) => m.detail));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('propose.failed'));
    } finally {
      setBusy(false);
    }
  };

  const pick = (values: string[]) => values.map((v) => ({ label: v, value: v }));
  // Pickers sit in plain divs, never a <label>: a label passes the click on to the
  // picker it wraps, which opens and at once closes it again.

  return (
    <div className="space-y-4 text-xs">
      <p className="text-slate-500 dark:text-slate-400">{t('propose.intro')}</p>
      <div className="flex gap-2">
        {(['bind-named-formula', 'ratio-kpis'] as Intent[]).map((i) => (
          <button key={i} type="button" onClick={() => setIntent(i)}
            className={`px-3 py-1.5 rounded-lg border font-semibold cursor-pointer ${intent === i ? 'bg-sky-600 text-white border-sky-600' : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'}`}>
            {t(`propose.intent.${i}`)}
          </button>
        ))}
      </div>

      {intent === 'bind-named-formula' ? (
        <div className="space-y-3">
          <div className="block space-y-1">
            <span className="font-medium text-slate-600 dark:text-slate-300">{t('propose.formula')}</span>
            <SelectPicker
              data={formulas.map((f) => ({ label: `${f.name} (${f.slug})`, value: f.slug }))}
              value={formula}
              onChange={setFormula}
              placeholder={formulas.length ? t('propose.chooseFormula') : t('propose.noFormulas')}
              block
              size="sm"
            />
          </div>
          {formula && <p className="text-slate-500">{formulas.find((f) => f.slug === formula)?.description}</p>}
          {openRoles.map((r) => (
            <div key={r.role} className="block space-y-1">
              <span className="font-medium text-slate-600 dark:text-slate-300">{t('propose.signalFor', { role: r.role })}</span>
              <SelectPicker data={pick(signals)} value={bindings[r.role] ?? null} onChange={(v) => setBindings((b) => ({ ...b, [r.role]: v ?? '' }))} block size="sm" />
              <span className="block text-[11px] text-amber-600 dark:text-amber-400">{r.detail}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="block space-y-1">
            <span className="font-medium text-slate-600 dark:text-slate-300">{t('propose.numerator')}</span>
            <SelectPicker data={pick(kpiKeys)} value={numerator} onChange={setNumerator} block size="sm" />
          </div>
          <div className="block space-y-1">
            <span className="font-medium text-slate-600 dark:text-slate-300">{t('propose.denominator')}</span>
            <SelectPicker data={pick(kpiKeys)} value={denominator} onChange={setDenominator} block size="sm" />
          </div>
          {kpiKeys.length < 2 && <p className="sm:col-span-2 text-slate-400">{t('propose.needTwoKpis')}</p>}
          {numerator && denominator && numerator === denominator && (
            <p className="sm:col-span-2 text-amber-600 dark:text-amber-400 font-medium">
              {t('propose.sameKpiWarning', { defaultValue: 'Numerator and denominator must be different KPIs to form a ratio.' })}
            </p>
          )}
        </div>
      )}

      {missing.length > 0 && <div className="text-amber-700 dark:text-amber-300 space-y-0.5">{missing.map((m, i) => <p key={i}>{m}</p>)}</div>}
      {error && <div className="flex items-start gap-2 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2"><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{error}</span></div>}

      <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
        <button onClick={submit} disabled={!ready || busy}
          className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold disabled:opacity-50 cursor-pointer">
          {busy ? t('propose.proposing') : t('propose.submit')}
        </button>
      </div>
    </div>
  );
};
