import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export type CareFeatureKey = 'things-care' | 'things-shield' | 'production-monitoring';

// Labels: the two product names stay as they are; 'Production' is a fleet-namespace key.
const FEATURES: { key: CareFeatureKey; label: string; i18nKey?: string }[] = [
  { key: 'things-care', label: 'ThingsCare' },
  { key: 'things-shield', label: 'ThingsShield' },
  { key: 'production-monitoring', label: 'Production', i18nKey: 'crossLinks.production' },
];

const pillClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border';
const linkClass = `${pillClass} border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300`;
const activeClass = `${pillClass} bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-400 border-sky-200 dark:border-sky-900`;

// Shared cross-link row for the ThingsCare / ThingsShield / Production
// Monitoring detail pages — each is a different lens on the same equipment,
// so every one of their detail pages lets you jump straight to the others for
// that same Thing. `current` renders as an inert "you are here" pill instead
// of a link.
export const FeatureCrossLinks: React.FC<{ thingId: string; current: CareFeatureKey }> = ({ thingId, current }) => {
  const navigate = useNavigate();
  const { t } = useTranslation('fleet');
  const label = (f: (typeof FEATURES)[number]) => (f.i18nKey ? t(f.i18nKey) : f.label);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={() => navigate(`/dashboard/${thingId}`)} className={linkClass}>
        {t('crossLinks.thingDetails')}
      </button>
      {FEATURES.map((f) => (
        f.key === current
          ? <span key={f.key} className={activeClass}>{label(f)}</span>
          : <button key={f.key} onClick={() => navigate(`/${f.key}/${thingId}`)} className={linkClass}>{label(f)}</button>
      ))}
    </div>
  );
};
