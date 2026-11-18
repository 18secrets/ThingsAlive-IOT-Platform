import React from 'react';
import { SelectPicker } from 'rsuite';
import { useTranslation } from 'react-i18next';
import type { EquipmentModel } from '../../lib/api';

/**
 * A machine's model (D57), on both Add equipment forms: the account's models of the chosen
 * machine type. Optional — a vehicle needs none — so a machine saved without one is
 * accepted; but where the account has models of this type and none is chosen, the form
 * says what that costs (rated alerts and load figures wait), instead of saving quietly and
 * leaving the alerts idle (17 Nov).
 */
export const ModelField: React.FC<{
  models: EquipmentModel[];
  classSlug: string;
  value: string | null;
  onChange: (id: string | null) => void;
  /** Master Admin's form: the models are the chosen client's, and only the client adds one. */
  forClient?: boolean;
}> = ({ models, classSlug, value, onChange, forClient = false }) => {
  const { t } = useTranslation('equipment');
  const options = models.filter((m) => m.equipmentClassSlug === classSlug)
    // The maker before the name, unless the name already starts with it ("Crompton Crompton Mini 1 HP").
    .map((m) => ({
      label: m.manufacturer && !m.name.toLowerCase().startsWith(m.manufacturer.toLowerCase()) ? `${m.manufacturer} ${m.name}` : m.name,
      value: m.id,
    }));
  return (
    <div>
      <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('equipmentForm.model')}</span>
      <SelectPicker
        data={options}
        value={value}
        onChange={onChange}
        placeholder={options.length ? t('equipmentForm.modelPlaceholder') : t('equipmentForm.noModelsOfType')}
        disabled={!options.length}
        searchable={options.length > 6}
        block
      />
      {options.length > 0 && !value ? (
        <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-md px-2 py-1.5 mt-1.5">
          {t('equipmentForm.modelMissing')}
        </p>
      ) : (
        <p className="text-xs text-slate-400 mt-1">
          {options.length === 0 && forClient ? t('equipmentForm.noModelsForClient') : t('equipmentForm.modelHint')}
        </p>
      )}
    </div>
  );
};
