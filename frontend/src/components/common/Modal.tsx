import React from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Tailwind max-width class for the panel. Defaults to the size used by
   *  the admin side's own CRUD modals (AddPlantModal, AddUserModal, …). */
  maxWidth?: string;
  children: React.ReactNode;
}

// Same overlay/panel convention already used throughout the admin side
// (AddPlantModal.tsx, RoleManagement.tsx's AddRoleModal, AddUserModal.tsx,
// etc.) — header/footer pinned via shrink-0, body scrolls independently.
// Pulled out here so client-facing forms (ThingsShield, Work Orders, Rule
// Builder, Cost Administration) stop being separate routes or same-page
// drilldowns and open as this instead.
export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, subtitle, maxWidth = 'max-w-md', children }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
      <div className={`bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full ${maxWidth} max-h-[90vh] flex flex-col overflow-hidden`}>
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/60 dark:bg-slate-800/40 shrink-0">
          <div>
            <h3 className="font-bold text-slate-800 dark:text-white text-base">{title}</h3>
            {subtitle && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6 space-y-4 text-sm overflow-y-auto min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
};
