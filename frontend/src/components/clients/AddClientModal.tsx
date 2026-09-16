import React, { useEffect, useState } from 'react';
import { X, Check, RefreshCw, Copy, CheckCheck } from 'lucide-react';
import { ClientAccount } from '../../types';

interface AddClientModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (client: ClientAccount) => void;
  existingUsernames: string[];
  existingClient?: ClientAccount | null;
}

const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let pwd = '';
  for (let i = 0; i < 10; i++) {
    pwd += chars[Math.floor(Math.random() * chars.length)];
  }
  return pwd;
};

const slugify = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');

export const AddClientModal: React.FC<AddClientModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingUsernames,
  existingClient,
}) => {
  const [clientName, setClientName] = useState('');
  const [contactPersonName, setContactPersonName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [password, setPassword] = useState(generatePassword());
  const [copiedField, setCopiedField] = useState<'username' | 'password' | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  // Re-sync form fields whenever the modal opens, for either a fresh client
  // or a different existing one to edit.
  useEffect(() => {
    if (!isOpen) return;
    if (existingClient) {
      setClientName(existingClient.clientName);
      setContactPersonName(existingClient.contactPersonName);
      setPhone(existingClient.phone);
      setEmail(existingClient.email);
      setUsername(existingClient.username);
      setUsernameTouched(true);
    } else {
      setClientName('');
      setContactPersonName('');
      setPhone('');
      setEmail('');
      setUsername('');
      setUsernameTouched(false);
      setPassword(generatePassword());
    }
    setCopiedField(null);
    setError(undefined);
  }, [isOpen, existingClient]);

  if (!isOpen) return null;

  const isEditing = !!existingClient;

  const handleClientNameChange = (value: string) => {
    setClientName(value);
    if (!usernameTouched) {
      setUsername(slugify(value));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalUsername = username.trim();
    const finalContactPerson = contactPersonName.trim();
    const finalPhone = phone.trim();
    const finalEmail = email.trim();
    const finalPassword = password.trim();

    if (!clientName.trim() || !finalUsername || !finalContactPerson || !finalPhone || !finalEmail) return;
    if (!isEditing && !finalPassword) return;
    if (existingUsernames.includes(finalUsername.toLowerCase())) {
      setError('That username is already taken by another client.');
      return;
    }
    if (!/^\S+@\S+\.\S+$/.test(finalEmail)) {
      setError('Please enter a valid email address.');
      return;
    }

    const client: ClientAccount = isEditing
      ? {
          ...existingClient!,
          clientName: clientName.trim(),
          contactPersonName: finalContactPerson,
          phone: finalPhone,
          email: finalEmail,
          username: finalUsername,
        }
      : {
          id: `cl-${Date.now()}`,
          clientName: clientName.trim(),
          contactPersonName: finalContactPerson,
          phone: finalPhone,
          email: finalEmail,
          username: finalUsername,
          password: finalPassword,
          mustChangePassword: true,
          status: 'Active',
          createdAt: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        };

    onSave(client);
    onClose();
  };

  // Copies exactly one value at a time — the previous "Username: X\nPassword: Y"
  // combined copy was easy to paste as one block into a single login field,
  // which silently breaks the exact-match comparison and looks like a bad
  // username/password.
  const handleCopyUsername = () => {
    navigator.clipboard?.writeText(username).then(() => {
      setCopiedField('username');
      setTimeout(() => setCopiedField((current) => (current === 'username' ? null : current)), 1500);
    }).catch(() => {});
  };

  const handleCopyPassword = () => {
    navigator.clipboard?.writeText(password).then(() => {
      setCopiedField('password');
      setTimeout(() => setCopiedField((current) => (current === 'password' ? null : current)), 1500);
    }).catch(() => {});
  };

  return (
    <div
      id="addClientModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md overflow-hidden">

        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40">
          <h3 className="font-semibold text-base text-slate-800 dark:text-slate-100">
            {isEditing ? 'Edit Client' : 'Add New Client'}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-sm">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Client Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={clientName}
              onChange={(e) => handleClientNameChange(e.target.value)}
              placeholder="e.g. Acme Cement Works"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Contact Person Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={contactPersonName}
              onChange={(e) => setContactPersonName(e.target.value)}
              placeholder="e.g. Rohan Kapoor"
              className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Phone Number <span className="text-rose-500">*</span>
              </label>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. +91 98100 22341"
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Email ID <span className="text-rose-500">*</span>
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(undefined); }}
                placeholder="e.g. rohan@acmecement.com"
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Username <span className="text-rose-500">*</span>
            </label>
            <div className="relative">
              <input
                type="text"
                required
                value={username}
                onChange={(e) => { setUsername(e.target.value); setUsernameTouched(true); setError(undefined); }}
                placeholder="e.g. acme.cement"
                className="w-full px-3 py-2 pr-9 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors font-mono"
              />
              {username && (
                <button
                  type="button"
                  onClick={handleCopyUsername}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                  title="Copy username"
                >
                  {copiedField === 'username' ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              {isEditing ? 'Used to sign in — change with care.' : 'Auto-filled from the client name — feel free to edit.'}
            </p>
          </div>

          {!isEditing && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Temporary Password <span className="text-rose-500">*</span>
                </label>
                <button
                  type="button"
                  onClick={() => setPassword(generatePassword())}
                  className="text-[11px] text-sky-600 hover:text-sky-700 dark:text-sky-400 font-medium flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Regenerate</span>
                </button>
              </div>
              <div className="relative">
                <input
                  type="text"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2 pr-9 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors font-mono"
                />
                <button
                  type="button"
                  onClick={handleCopyPassword}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                  title="Copy password"
                >
                  {copiedField === 'password' ? <CheckCheck className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-1">
                Copy the username and password separately — the client will be required to change this on first login.
              </p>
            </div>
          )}

          {isEditing && (
            <p className="text-[11px] text-slate-400 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2">
              Password isn't changed here — use "Reset Password" on the client card to force a new one.
            </p>
          )}

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
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Check className="w-4 h-4" />
              <span>{isEditing ? 'Save Changes' : 'Create Client'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
