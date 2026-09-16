import React, { useState } from 'react';
import { X, Check, Info } from 'lucide-react';
import { PlantItem, ClientAccount } from '../../types';

interface AddPlantModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (plant: PlantItem) => void;
  existingPlant?: PlantItem | null;
  clients: ClientAccount[];
}

export const AddPlantModal: React.FC<AddPlantModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingPlant,
  clients,
}) => {
  const [name, setName] = useState(existingPlant?.name || '');
  const [location, setLocation] = useState(existingPlant?.location || '');
  const [code, setCode] = useState(existingPlant?.code || '');
  const [clientId, setClientId] = useState(existingPlant?.clientId || (clients.length === 1 ? clients[0].id : ''));
  const [statusActive, setStatusActive] = useState(existingPlant?.active ?? true);
  const clientLocked = clients.length === 1;

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const selectedClient = clients.find((c) => c.id === clientId);
    if (!name.trim() || !selectedClient) return;

    const newPlant: PlantItem = {
      id: existingPlant?.id || `PLANT-${Date.now().toString().slice(-4)}`,
      name: name.trim(),
      location: location.trim() || 'Industrial Complex',
      code: existingPlant
        ? (code.trim() || existingPlant.code)
        : (code.trim() || name.slice(0, 3).toUpperCase()) + `-${Math.floor(10 + Math.random() * 90)}`,
      equipmentCount: existingPlant?.equipmentCount || 0,
      active: statusActive,
      clientId: selectedClient.id,
      clientName: selectedClient.clientName,
    };

    onSave(newPlant);
    onClose();
  };

  return (
    <div
      id="addPlantModalOverlay"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {existingPlant ? 'Edit Plant / Depot' : 'Register New Plant / Depot'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                Regional production facility, maintenance depot, or assembly site
              </p>
            </div>
          </div>
          <button
            id="close-plant-modal-btn"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body Form */}
        <form onSubmit={handleSubmit} className="px-7 py-6 space-y-5">

          {/* Client */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Client <span className="text-rose-500">*</span>
            </label>
            <select
              required
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={clientLocked}
              className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white appearance-none focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all pr-9 cursor-pointer disabled:bg-slate-50 dark:disabled:bg-slate-800/40 disabled:cursor-not-allowed"
            >
              <option value="" disabled>Select a client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.clientName}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Plant Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Hyderabad Central Works"
              className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Location <span className="text-slate-400 font-normal">(City, State)</span>
              </label>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="e.g. Hyderabad, Telangana"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Plant Code
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. HYD-WKS"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all font-mono"
              />
            </div>
          </div>

          {/* Status toggle */}
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-700/30">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-xs">
                <Check className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Plant Status</div>
                <div className="text-[11px] text-slate-400">Enable this plant immediately for equipment and device assignment</div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setStatusActive(!statusActive)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                statusActive ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  statusActive ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Modal Footer Buttons */}
          <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-slate-400" />
              Fields marked with <span className="text-rose-500 font-bold">*</span> are mandatory
            </span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-6 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-700 active:bg-sky-800 text-white text-xs font-semibold transition-colors shadow-xs flex items-center gap-2 cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{existingPlant ? 'Save Plant' : 'Register Plant'}</span>
              </button>
            </div>
          </div>

        </form>

      </div>
    </div>
  );
};
