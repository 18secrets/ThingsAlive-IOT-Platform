import React, { useEffect, useMemo, useState } from 'react';
import { X, Plus, Ban, Package } from 'lucide-react';
import { CheckPicker, Input } from 'rsuite';
import { useTranslation } from 'react-i18next';
import { ClientAccount } from '../../types';
import {
  ApiError, EquipmentModel, ModelGrant, apiGrantModel, apiListModelGrants, apiListModels, apiRevokeModelGrant,
} from '../../lib/api';

interface ClientModelGrantsModalProps {
  client: ClientAccount | null;
  onClose: () => void;
}

const modelLabel = (m: EquipmentModel) => [m.manufacturer, m.name].filter(Boolean).join(' ');

/**
 * Which library models an account is given (TC_234), beside Granted Classes and shaped
 * like it. The account's "Copy a library model" list shows only these. Loads its own
 * data: the library and one account's grants are wanted only while this is open.
 */
export const ClientModelGrantsModal: React.FC<ClientModelGrantsModalProps> = ({ client, onClose }) => {
  const { t } = useTranslation(['accounts', 'shared']);
  const [models, setModels] = useState<EquipmentModel[]>([]);
  const [grants, setGrants] = useState<ModelGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const refreshGrants = async (tenantId: string) => setGrants(await apiListModelGrants(tenantId));

  useEffect(() => {
    if (!client) return;
    setSelectedIds([]);
    setNote('');
    setError(undefined);
    setLoading(true);
    Promise.all([apiListModels('library'), apiListModelGrants(client.id)])
      .then(([library, given]) => { setModels(library); setGrants(given); })
      .catch((err) => setError(err instanceof ApiError ? err.message : t('modelGrants.loadFailed')))
      .finally(() => setLoading(false));
  }, [client, t]);

  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);
  const activeGrants = useMemo(() => grants.filter((g) => !g.revokedAt), [grants]);
  const grantableOptions = useMemo(
    () => models
      .filter((m) => !activeGrants.some((g) => g.templateId === m.id))
      .map((m) => ({ label: modelLabel(m), value: m.id })),
    [models, activeGrants],
  );

  if (!client) return null;

  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedIds.length) return;
    setBusy(true);
    setError(undefined);
    try {
      // One call per model, in turn, so a failure partway names where it stopped
      // rather than racing several writes against the same account.
      for (const id of selectedIds) {
        await apiGrantModel(client.id, id, note.trim() || undefined);
      }
      setSelectedIds([]);
      setNote('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('modelGrants.grantFailed'));
    } finally {
      await refreshGrants(client.id).catch(() => undefined);
      setBusy(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    setError(undefined);
    try {
      await apiRevokeModelGrant(id);
      await refreshGrants(client.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('modelGrants.revokeFailed'));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div
      id="clientModelGrantsModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <div className="min-w-0">
            <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">{t('modelGrants.title')}</h3>
            <p className="text-xs text-slate-500 mt-0.5 truncate">{client.clientName}</p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('shared:close')}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-sm max-h-[70vh] overflow-y-auto">
          <div>
            <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">{t('modelGrants.current')}</h4>
            {loading ? (
              <p className="text-xs text-slate-500">{t('modelGrants.loading')}</p>
            ) : activeGrants.length === 0 ? (
              <p className="text-xs text-slate-500">{t('modelGrants.none')}</p>
            ) : (
              <ul className="space-y-2">
                {activeGrants.map((g) => {
                  const model = byId.get(g.templateId);
                  return (
                    <li
                      key={g.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Package className="w-3.5 h-3.5 text-sky-600 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs text-slate-800 dark:text-slate-100 truncate">
                            {model ? modelLabel(model) : g.templateId}
                          </p>
                          {model?.equipmentClassSlug && (
                            <p className="font-mono text-xs text-slate-500 truncate">{model.equipmentClassSlug}</p>
                          )}
                          {g.note && <p className="text-xs text-slate-500 truncate">{g.note}</p>}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRevoke(g.id)}
                        disabled={revokingId === g.id}
                        className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
                        title={t('modelGrants.revoke')}
                        aria-label={t('modelGrants.revoke')}
                      >
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-slate-500 mt-2">{t('modelGrants.revokeKeepsCopies')}</p>
          </div>

          <form onSubmit={handleGrant} className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">{t('modelGrants.grantHeading')}</h4>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('modelGrants.models')} <span className="text-rose-500">*</span>
              </label>
              {loading ? null : grantableOptions.length === 0 ? (
                <p className="text-xs text-slate-500">
                  {models.length === 0 ? t('modelGrants.noModels') : t('modelGrants.allGranted')}
                </p>
              ) : (
                <CheckPicker
                  data={grantableOptions}
                  value={selectedIds}
                  onChange={(value) => setSelectedIds(value ?? [])}
                  placeholder={t('modelGrants.selectPlaceholder')}
                  block
                  searchable={grantableOptions.length > 6}
                />
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">{t('modelGrants.note')}</label>
              <Input value={note} onChange={(value) => setNote(value)} placeholder={t('shared:optional')} />
            </div>

            {error && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy || selectedIds.length === 0}
                className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" />
                <span>
                  {busy
                    ? t('modelGrants.granting')
                    : (selectedIds.length ? t('modelGrants.grantCount', { count: selectedIds.length }) : t('modelGrants.grant'))}
                </span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
