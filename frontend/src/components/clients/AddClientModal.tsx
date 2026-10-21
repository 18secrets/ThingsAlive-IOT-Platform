import React, { useEffect, useState } from 'react';
import { X, Check, Copy, CheckCheck } from 'lucide-react';
import { Input } from 'rsuite';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError, Account, CreateAccountResult } from '../../lib/api';
import { ClientAccount } from '../../types';
import { copyToClipboard } from '../../lib/clipboard';

interface AddClientModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (
    input: { tenantId: string; name: string; email: string; fullName: string; phone?: string },
  ) => Promise<CreateAccountResult>;
  onUpdate: (
    tenantId: string,
    input: { name: string; email: string; fullName: string; phone?: string },
  ) => Promise<Account>;
  /** Present to edit that account instead of creating a new one. */
  existingClient?: ClientAccount | null;
}

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const AddClientModal: React.FC<AddClientModalProps> = ({
  isOpen, onClose, onCreate, onUpdate, existingClient,
}) => {
  const { t } = useTranslation(['accounts', 'shared']);
  const [clientName, setClientName] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [tenantIdTouched, setTenantIdTouched] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<CreateAccountResult | null>(null);
  const [copied, setCopied] = useState(false);

  const isEditing = !!existingClient;

  useEffect(() => {
    if (!isOpen) return;
    if (existingClient) {
      setClientName(existingClient.clientName);
      setTenantId(existingClient.id);
      setTenantIdTouched(true);
      setFullName(existingClient.contactPersonName ?? '');
      setPhone(existingClient.phone ?? '');
      setEmail(existingClient.email ?? '');
    } else {
      setClientName('');
      setTenantId('');
      setTenantIdTouched(false);
      setFullName('');
      setPhone('');
      setEmail('');
    }
    setError(undefined);
    setCreated(null);
    setCopied(false);
  }, [isOpen, existingClient]);

  if (!isOpen) return null;

  const handleClientNameChange = (value: string) => {
    setClientName(value);
    if (!isEditing && !tenantIdTouched) setTenantId(slugify(value));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalTenantId = tenantId.trim();
    const finalFullName = fullName.trim();
    const finalPhone = phone.trim();
    const finalEmail = email.trim();
    if (!clientName.trim() || !finalTenantId || !finalFullName || !finalPhone || !finalEmail) return;

    setBusy(true);
    setError(undefined);
    try {
      if (existingClient) {
        await onUpdate(existingClient.id, {
          name: clientName.trim(), email: finalEmail, fullName: finalFullName, phone: finalPhone,
        });
        onClose();
      } else {
        const result = await onCreate({
          tenantId: finalTenantId, name: clientName.trim(), email: finalEmail, fullName: finalFullName, phone: finalPhone,
        });
        setCreated(result);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (existingClient ? t('addClient.saveFailed') : t('addClient.createFailed')));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyToken = () => {
    if (!created) return;
    copyToClipboard(created.invitationToken).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    });
  };

  return (
    <div
      id="addClientModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">

        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {created ? t('addClient.createdTitle') : isEditing ? t('addClient.editTitle') : t('addClient.addTitle')}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('shared:close')}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {created ? (
          <div className="p-6 space-y-4 text-sm">
            <p className="text-slate-600 dark:text-slate-300">
              <Trans
                t={t}
                i18nKey="addClient.provisioned"
                values={{ name: created.tenant.name, email: created.superAdmin.email }}
                components={{ 1: <strong className="text-slate-900 dark:text-white" />, 3: <strong className="font-mono" /> }}
              />
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('shared:token.label')}
              </label>
              <div className="relative">
                <Input
                  readOnly
                  value={created.invitationToken}
                  className="pr-9 font-mono"
                />
                <button
                  type="button"
                  onClick={handleCopyToken}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                  title={t('shared:token.copy')}
                >
                  {copied ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                <Trans
                  t={t}
                  i18nKey="addClient.tokenHelp"
                  values={{ when: new Date(created.invitationExpiresAt).toLocaleString() }}
                  components={{ 1: <code /> }}
                />
              </p>
            </div>
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
              <button
                onClick={onClose}
                className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer"
              >
                {t('shared:done')}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('addClient.clientName')} <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                autoFocus
                value={clientName}
                onChange={(value) => handleClientNameChange(value)}
                placeholder={t('addClient.clientNamePlaceholder')}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('addClient.accountId')} <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                disabled={isEditing}
                value={tenantId}
                onChange={(value) => { setTenantId(value); setTenantIdTouched(true); }}
                placeholder={t('addClient.accountIdPlaceholder')}
                className="font-mono"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                {isEditing
                  ? t('addClient.accountIdLocked')
                  : t('addClient.accountIdHint')}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                {t('addClient.fullName')} <span className="text-rose-500">*</span>
              </label>
              <Input
                required
                value={fullName}
                onChange={(value) => setFullName(value)}
                placeholder={t('addClient.fullNamePlaceholder')}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {t('addClient.phone')} <span className="text-rose-500">*</span>
                </label>
                <Input
                  type="tel"
                  required
                  value={phone}
                  onChange={(value) => setPhone(value)}
                  placeholder={t('addClient.phonePlaceholder')}
                  className="font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {t('addClient.email')} <span className="text-rose-500">*</span>
                </label>
                <Input
                  type="email"
                  required
                  value={email}
                  onChange={(value) => setEmail(value)}
                  placeholder={t('addClient.emailPlaceholder')}
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-400 -mt-2">
              {isEditing
                ? t('addClient.emailEditHint')
                : t('addClient.emailHint')}
            </p>

            {error && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                {t('shared:cancel')}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Check className="w-4 h-4" />
                <span>{busy ? (isEditing ? t('shared:saving') : t('shared:creating')) : (isEditing ? t('shared:saveChanges') : t('addClient.create'))}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
