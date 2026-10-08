import React, { useMemo, useState } from 'react';
import { X, Plus, Ban, Layers } from 'lucide-react';
import { CheckPicker, Input } from 'rsuite';
import { ClientAccount } from '../../types';
import { ApiError, Entitlement, EquipmentClass } from '../../lib/api';

interface ClientEntitlementsModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: ClientAccount | null;
  /** Every equipment class, draft and published — filtered here to published only. */
  equipmentClasses: EquipmentClass[];
  entitlements: Entitlement[];
  onGrant: (tenantId: string, equipmentClassSlug: string, note?: string) => Promise<Entitlement>;
  onRevoke: (id: string) => Promise<Entitlement>;
}

export const ClientEntitlementsModal: React.FC<ClientEntitlementsModalProps> = ({
  isOpen, onClose, client, equipmentClasses, entitlements, onGrant, onRevoke,
}) => {
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  const publishedClasses = useMemo(() => {
    // The authoring list carries every version ever published; publishing a new
    // one is supposed to retire the version it replaces, but a slug can still
    // momentarily (or, for old data, permanently) show two 'published' rows.
    // Keyed by slug so neither the duplicate nor a React key collision over it
    // hides the class from this picker.
    const bySlug = new Map<string, EquipmentClass>();
    for (const ec of equipmentClasses) {
      if (ec.status !== 'published') continue;
      const current = bySlug.get(ec.slug);
      if (!current || ec.version > current.version) bySlug.set(ec.slug, ec);
    }
    return [...bySlug.values()];
  }, [equipmentClasses]);

  const clientEntitlements = useMemo(
    () => (client ? entitlements.filter((e) => e.tenantId === client.id) : []),
    [entitlements, client],
  );

  const activeGrants = clientEntitlements.filter((e) => !e.revokedAt);
  const grantableClasses = publishedClasses.filter(
    (ec) => !activeGrants.some((g) => g.equipmentClassSlug === ec.slug),
  );
  const grantableOptions = useMemo(
    () => grantableClasses.map((ec) => ({ label: ec.name ?? ec.slug, value: ec.slug })),
    [grantableClasses],
  );

  if (!isOpen || !client) return null;

  const handleGrant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSlugs.length) return;
    setBusy(true);
    setError(undefined);
    try {
      // One call per class — the backend grants one (tenant, class) pair at a
      // time; sequential so a failure partway through names which slug failed
      // rather than racing several writes against the same tenant at once.
      for (const slug of selectedSlugs) {
        await onGrant(client.id, slug, note.trim() || undefined);
      }
      setSelectedSlugs([]);
      setNote('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not grant one or more classes.');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    setError(undefined);
    try {
      await onRevoke(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke this grant.');
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div
      id="clientEntitlementsModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <div>
            <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">Granted Classes</h3>
            <p className="text-[11px] text-slate-400 mt-0.5">{client.clientName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 text-sm max-h-[70vh] overflow-y-auto">
          <div>
            <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">Current grants</h4>
            {activeGrants.length === 0 ? (
              <p className="text-xs text-slate-400">No equipment classes granted yet.</p>
            ) : (
              <ul className="space-y-2">
                {activeGrants.map((g) => (
                  <li
                    key={g.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Layers className="w-3.5 h-3.5 text-sky-600 shrink-0" />
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-slate-800 dark:text-slate-100 truncate">{g.equipmentClassSlug}</p>
                        {g.note && <p className="text-[11px] text-slate-400 truncate">{g.note}</p>}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRevoke(g.id)}
                      disabled={revokingId === g.id}
                      className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
                      title="Revoke"
                    >
                      <Ban className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <form onSubmit={handleGrant} className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
            <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">Grant classes</h4>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Equipment Classes <span className="text-rose-500">*</span>
              </label>
              {grantableClasses.length === 0 ? (
                <p className="text-[11px] text-slate-400">
                  {publishedClasses.length === 0
                    ? 'No published equipment classes exist yet.'
                    : 'Every published class is already granted.'}
                </p>
              ) : (
                <CheckPicker
                  data={grantableOptions}
                  value={selectedSlugs}
                  onChange={(value) => setSelectedSlugs(value ?? [])}
                  placeholder="Select a published class…"
                  block
                  searchable={grantableOptions.length > 6}
                />
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Note</label>
              <Input
                value={note}
                onChange={(value) => setNote(value)}
                placeholder="Optional"
              />
            </div>

            {error && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={busy || selectedSlugs.length === 0}
                className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" />
                <span>{busy ? 'Granting…' : `Grant${selectedSlugs.length ? ` (${selectedSlugs.length})` : ''}`}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
