import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';

/** The five pages that each show one machine from a different angle. */
export type MachineView = 'detail' | 'equipment' | 'care' | 'production' | 'shield';

/**
 * The same row of links on every per-machine page, so moving between a machine's
 * views never means going back to a list and finding it again. The page you are on
 * is left out rather than shown disabled: a button that goes nowhere is noise.
 * `inverse` is for the white-on-colour header the Equipment page draws.
 */
export const MachineLinks: React.FC<{
  sourceSystem: string;
  externalId: string;
  current: MachineView;
  inverse?: boolean;
}> = ({ sourceSystem, externalId, current, inverse = false }) => {
  const navigate = useNavigate();
  const { t } = useTranslation('dashboard');
  const id = `${encodeURIComponent(sourceSystem)}/${encodeURIComponent(externalId)}`;

  const links: { view: MachineView; label: string; to: string }[] = [
    { view: 'detail', label: t('thingLive.equipmentDetail'), to: `/dashboard/${id}` },
    { view: 'equipment', label: t('thingLive.equipmentPage'), to: `/admin/equipment/${id}/page` },
    { view: 'care', label: 'ThingsCare', to: `/things-care/${id}` },
    { view: 'production', label: t('thingLive.production'), to: `/production-monitoring/${id}` },
    { view: 'shield', label: 'ThingsShield', to: `/things-shield/${id}` },
  ];

  const tone = inverse
    ? 'border-white/70 text-white hover:bg-white/10'
    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-sky-300';

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      {links.filter((l) => l.view !== current).map((l) => (
        <button
          key={l.view}
          onClick={() => navigate(l.to)}
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border cursor-pointer ${tone}`}
        >
          <ExternalLink className="w-3 h-3" /> {l.label}
        </button>
      ))}
    </div>
  );
};
