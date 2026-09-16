import React, { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Wrench,
  Edit2,
  Trash2,
  Fuel
} from 'lucide-react';
import { CategoryItem } from '../../types';
import { AddCategoryModal } from './AddCategoryModal';

interface CategoryViewProps {
  categories: CategoryItem[];
  onAddCategory: (category: CategoryItem) => void;
  onUpdateCategory: (category: CategoryItem) => void;
  onDeleteCategory: (id: string) => void;
}

export const CategoryView: React.FC<CategoryViewProps> = ({
  categories,
  onAddCategory,
  onUpdateCategory,
  onDeleteCategory,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<CategoryItem | null>(null);

  // Filtered categories
  const filteredCategories = useMemo(() => {
    return categories.filter((c) =>
      c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.description.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [categories, searchTerm]);

  const handleToggleActive = (cat: CategoryItem) => {
    onUpdateCategory({
      ...cat,
      active: !cat.active,
    });
  };

  return (
    <div id="category-management-view" className="space-y-6">

      {/* Search & Add Action Bar */}
      <div className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input 
            type="text" 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search Category Names, Codes, or Specs..." 
            className="w-full pl-9 pr-4 py-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors"
          />
        </div>

        <button 
          id="add-category-btn"
          onClick={() => {
            setEditingCategory(null);
            setIsModalOpen(true);
          }}
          className="w-full sm:w-auto px-5 py-2.5 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-xs font-semibold shadow-xs flex items-center justify-center gap-2 transition-colors shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Category</span>
        </button>
      </div>

      {/* Category Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredCategories.map((cat) => (
          <div 
            key={cat.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs flex flex-col justify-between hover:border-sky-300 dark:hover:border-sky-700 transition-all space-y-4"
          >
            {/* Card Header */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  #{cat.code}
                </span>

                <div className="flex items-center gap-1.5">
                  {/* Status Toggle Switch */}
                  <button
                    onClick={() => handleToggleActive(cat)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none cursor-pointer ${
                      cat.active ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-600'
                    }`}
                    title={cat.active ? 'Active' : 'Inactive'}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        cat.active ? 'translate-x-4.5' : 'translate-x-1'
                      }`}
                    />
                  </button>

                  {/* Edit Button */}
                  <button
                    onClick={() => {
                      setEditingCategory(cat);
                      setIsModalOpen(true);
                    }}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-sky-600 hover:border-sky-300 transition-colors cursor-pointer"
                    title="Edit Category"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>

                  {/* Delete Button */}
                  <button
                    onClick={() => onDeleteCategory(cat.id)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 hover:border-rose-300 transition-colors cursor-pointer"
                    title="Delete Category"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <h4 className="font-semibold text-slate-900 dark:text-white text-base leading-snug">
                {cat.name}
              </h4>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Created: {cat.createdAt}
              </p>
            </div>

            {/* Spec tags */}
            <div className="space-y-2 text-xs">
              <p className="text-slate-600 dark:text-slate-300 line-clamp-2 text-xs leading-relaxed">
                {cat.description}
              </p>

              <div className="flex flex-wrap gap-2 pt-1">
                {/* Equipment count */}
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                  <Wrench className="w-3 h-3 text-sky-600" />
                  <span>{cat.equipmentCount} Units</span>
                </div>

                {/* Powertrain spec */}
                {cat.fuelTankCapacityLiters > 0 && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px] font-mono rounded-md border border-slate-200 dark:border-slate-700">
                    <Fuel className="w-3 h-3 text-emerald-600" />
                    <span>{cat.fuelTankCapacityLiters}L Tank</span>
                  </div>
                )}
              </div>
            </div>

            {/* Status footer */}
            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-end text-xs text-slate-500 dark:text-slate-400">
              <span className={`font-semibold text-xs ${cat.active ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}>
                {cat.active ? '• Active' : '• Disabled'}
              </span>
            </div>

          </div>
        ))}
      </div>

      {/* Add / Edit Category Modal */}
      <AddCategoryModal 
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingCategory(null);
        }}
        onSave={(saved) => {
          if (editingCategory) {
            onUpdateCategory(saved);
          } else {
            onAddCategory(saved);
          }
        }}
        existingCategory={editingCategory}
      />
    </div>
  );
};
