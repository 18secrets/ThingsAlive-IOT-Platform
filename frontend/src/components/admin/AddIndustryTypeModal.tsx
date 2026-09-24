import React, { useState } from 'react';
import { X, Check, Info } from 'lucide-react';
import { IndustryTypeItem } from '../../types';

interface AddIndustryTypeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (industryType: IndustryTypeItem) => void;
  existingIndustryType?: IndustryTypeItem | null;
}

export const AddIndustryTypeModal: React.FC<AddIndustryTypeModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingIndustryType,
}) => {
  const [name, setName] = useState(existingIndustryType?.name || '');
  const [code, setCode] = useState(existingIndustryType?.code || '');
  const [statusActive, setStatusActive] = useState((existingIndustryType?.status ?? 'Active') === 'Active');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newIndustryType: IndustryTypeItem = {
      id: existingIndustryType?.id || `ind-${Date.now()}`,
      name: name.trim() || 'New Industry Type',
      code: (code.trim() || name.slice(0, 3).toUpperCase()).toUpperCase(),
      status: statusActive ? 'Active' : 'Inactive',
      createdAt: existingIndustryType?.createdAt || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    };
    onSave(newIndustryType);
    onClose();
  };

  return (
    <div
      id="addIndustryTypeModalOverlay"
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150"
    >
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-lg overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">

        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-800">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full bg-sky-600 ring-4 ring-sky-100 dark:ring-sky-950"></span>
            <div>
              <h3 className="font-bold text-slate-800 dark:text-white text-base">
                {existingIndustryType ? 'Edit Industry Type' : 'Add Industry Type'}
              </h3>
              <p className="text-xs text-slate-400 dark:text-slate-400">
                Define an industrial sector used across Sensors and Tool Mappings
              </p>
            </div>
          </div>
          <button
            id="close-industry-type-modal-btn"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body Form */}
        <form onSubmit={handleSubmit} className="px-7 py-6 space-y-5">

          {/* Name & Code */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Industry Type Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Power & Energy"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Code <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. PWR"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-xl text-xs text-slate-800 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/20 focus:border-sky-600 transition-all font-mono uppercase"
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
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">Industry Type Status</div>
                <div className="text-[11px] text-slate-400">Enable this domain immediately across Sensors and Tool Mappings</div>
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
                <span>Save Industry Type</span>
              </button>
            </div>
          </div>

        </form>

      </div>
    </div>
  );
};
