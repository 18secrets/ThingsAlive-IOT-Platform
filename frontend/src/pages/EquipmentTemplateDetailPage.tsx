import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Cog, Fuel, Radio, Bell, Sigma } from 'lucide-react';
import { EquipmentTemplate, Sensor, SensorCategory } from '../lib/api';
import { TemplateAlertRule, TemplateKpiFormula } from '../types';
import { usePageHeader } from '../lib/PageHeaderContext';
import { TemplateSensorsPanel } from '../components/admin/template-detail/TemplateSensorsPanel';
import { TemplateAlertRulesPanel } from '../components/admin/template-detail/TemplateAlertRulesPanel';
import { TemplateKpiFormulasPanel } from '../components/admin/template-detail/TemplateKpiFormulasPanel';

type DetailTab = 'sensors' | 'alerts' | 'kpis';

interface EquipmentTemplateDetailPageProps {
  templates: EquipmentTemplate[];
  allSensors: Sensor[];
  sensorCategories: SensorCategory[];
  templateSensorLinks: Record<string, string[]>;
  onAttachSensor: (templateId: string, sensorId: string) => void;
  onDetachSensor: (templateId: string, sensorId: string) => void;
  alertRules: TemplateAlertRule[];
  onCreateAlertRule: (rule: Omit<TemplateAlertRule, 'id' | 'createdAt'>) => void;
  onUpdateAlertRule: (rule: TemplateAlertRule) => void;
  onDeleteAlertRule: (id: string) => void;
  kpiFormulas: TemplateKpiFormula[];
  onCreateKpiFormula: (formula: Omit<TemplateKpiFormula, 'id' | 'createdAt'>) => void;
  onUpdateKpiFormula: (formula: TemplateKpiFormula) => void;
  onDeleteKpiFormula: (id: string) => void;
}

export const EquipmentTemplateDetailPage: React.FC<EquipmentTemplateDetailPageProps> = ({
  templates, allSensors, sensorCategories, templateSensorLinks, onAttachSensor, onDetachSensor,
  alertRules, onCreateAlertRule, onUpdateAlertRule, onDeleteAlertRule,
  kpiFormulas, onCreateKpiFormula, onUpdateKpiFormula, onDeleteKpiFormula,
}) => {
  const { templateId } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<DetailTab>('sensors');

  usePageHeader({
    title: 'Equipment Class Configuration',
    subtitle: 'Sensors, Alert Rules & KPI Formulas',
    breadcrumb: 'Equipment Templates',
    onBack: () => navigate('/admin/equipment-template'),
  });

  const template = templates.find((t) => t.id === templateId);
  if (!template) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center text-slate-400 text-sm">
        <p>No equipment template found.</p>
        <button onClick={() => navigate('/admin/equipment-template')} className="mt-3 text-sky-600 dark:text-sky-400 font-semibold text-xs cursor-pointer">
          Back to Equipment Templates
        </button>
      </div>
    );
  }

  const attachedSensorIds = templateSensorLinks[template.id] ?? [];
  const attachedSensors = allSensors.filter((s) => attachedSensorIds.includes(s.id));
  const rulesForTemplate = alertRules.filter((r) => r.equipmentTemplateId === template.id);
  const formulasForTemplate = kpiFormulas.filter((f) => f.equipmentTemplateId === template.id);

  const tabs: { id: DetailTab; label: string; icon: React.FC<{ className?: string }>; count: number }[] = [
    { id: 'sensors', label: 'Sensors', icon: Radio, count: attachedSensors.length },
    { id: 'alerts', label: 'Alert Rules', icon: Bell, count: rulesForTemplate.length },
    { id: 'kpis', label: 'KPI Formulas', icon: Sigma, count: formulasForTemplate.length },
  ];

  return (
    <div className="space-y-6" data-purpose="equipment-template-detail">
      <button
        onClick={() => navigate('/admin/equipment-template')}
        className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Equipment Templates</span>
      </button>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              {template.category && (
                <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                  {template.category}
                </span>
              )}
              {template.manufacturer && <span className="text-xs text-slate-400">{template.manufacturer}</span>}
            </div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{template.name}</h2>
            {template.description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xl">{template.description}</p>}
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {template.engineType && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                <Cog className="w-3 h-3 text-sky-600" /><span>{template.engineType}</span>
              </div>
            )}
            {template.fuelTankCapacityLiters != null && (
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-mono font-medium text-[11px] rounded-md border border-slate-200 dark:border-slate-700">
                <Fuel className="w-3 h-3 text-sky-600" /><span>{template.fuelTankCapacityLiters} L</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium rounded-lg border transition-all flex items-center gap-2 cursor-pointer ${
                isActive
                  ? 'bg-sky-100 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-700 shadow-xs font-semibold'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'}`} />
              <span>{t.label}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">{t.count}</span>
            </button>
          );
        })}
      </div>

      {tab === 'sensors' && (
        <TemplateSensorsPanel
          templateId={template.id}
          attachedSensorIds={attachedSensorIds}
          allSensors={allSensors}
          categories={sensorCategories}
          onAttach={onAttachSensor}
          onDetach={onDetachSensor}
        />
      )}
      {tab === 'alerts' && (
        <TemplateAlertRulesPanel
          templateId={template.id}
          attachedSensors={attachedSensors}
          rules={rulesForTemplate}
          onCreate={onCreateAlertRule}
          onUpdate={onUpdateAlertRule}
          onDelete={onDeleteAlertRule}
        />
      )}
      {tab === 'kpis' && (
        <TemplateKpiFormulasPanel
          templateId={template.id}
          attachedSensors={attachedSensors}
          formulas={formulasForTemplate}
          onCreate={onCreateKpiFormula}
          onUpdate={onUpdateKpiFormula}
          onDelete={onDeleteKpiFormula}
        />
      )}
    </div>
  );
};
