import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Activity, Bell } from 'lucide-react';
import {
  AlertRuleTemplate, AlertRuleTemplateInput, EquipmentClass, Scenario, ScenarioInput,
} from '../lib/api';
import { usePageHeader } from '../lib/PageHeaderContext';
import { ClassScenariosPanel } from '../components/admin/class-detail/ClassScenariosPanel';
import { ClassAlertTemplatesPanel } from '../components/admin/class-detail/ClassAlertTemplatesPanel';

type DetailTab = 'predictions' | 'alerts';

interface EquipmentClassDetailPageProps {
  classes: EquipmentClass[];
  scenarios: Scenario[];
  scenariosError?: string;
  onCreateScenario: (slug: string, equipmentClassSlug: string, input: ScenarioInput) => Promise<Scenario>;
  onUpdateScenario: (slug: string, input: ScenarioInput) => Promise<Scenario>;
  onPublishScenario: (slug: string) => Promise<void>;
  alertTemplates: AlertRuleTemplate[];
  alertTemplatesError?: string;
  onCreateAlertTemplate: (slug: string, equipmentClassSlug: string, input: AlertRuleTemplateInput) => Promise<AlertRuleTemplate>;
  onUpdateAlertTemplate: (slug: string, input: AlertRuleTemplateInput) => Promise<AlertRuleTemplate>;
  onPublishAlertTemplate: (slug: string) => Promise<void>;
  onRetireAlertTemplate: (slug: string) => Promise<void>;
}

/** The draft in progress if any, else the latest published version, else whatever's left. */
function representativeForSlug(rows: EquipmentClass[], slug: string): EquipmentClass | undefined {
  const versions = rows.filter((c) => c.slug === slug);
  return versions.find((v) => v.status === 'draft')
    ?? versions.find((v) => v.status === 'published')
    ?? versions[0];
}

export const EquipmentClassDetailPage: React.FC<EquipmentClassDetailPageProps> = ({
  classes, scenarios, scenariosError, onCreateScenario, onUpdateScenario, onPublishScenario,
  alertTemplates, alertTemplatesError, onCreateAlertTemplate, onUpdateAlertTemplate,
  onPublishAlertTemplate, onRetireAlertTemplate,
}) => {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<DetailTab>('predictions');

  usePageHeader({
    title: 'Equipment Class Configuration',
    subtitle: 'Prediction Scenarios & Alert Rules',
    breadcrumb: 'Equipment Classes',
    onBack: () => navigate('/admin/category'),
  });

  const cls = slug ? representativeForSlug(classes, slug) : undefined;
  if (!cls) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center text-slate-400 text-sm">
        <p>No equipment class found.</p>
        <button onClick={() => navigate('/admin/category')} className="mt-3 text-sky-600 dark:text-sky-400 font-semibold text-xs cursor-pointer">
          Back to Equipment Classes
        </button>
      </div>
    );
  }

  const scenariosForClass = scenarios.filter((s) => s.equipmentClassSlug === cls.slug);
  const alertTemplatesForClass = alertTemplates.filter((t) => t.equipmentClassSlug === cls.slug);
  const availableSignals = cls.expectedSignals.map((s) => s.signal);

  const tabs: { id: DetailTab; label: string; icon: React.FC<{ className?: string }>; count: number }[] = [
    { id: 'predictions', label: 'Predictive Maintenance', icon: Activity, count: scenariosForClass.length },
    { id: 'alerts', label: 'Alert Rules', icon: Bell, count: alertTemplatesForClass.length },
  ];

  return (
    <div className="space-y-6" data-purpose="equipment-class-detail">
      <button
        onClick={() => navigate('/admin/category')}
        className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Equipment Classes</span>
      </button>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-xs">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-xs font-semibold text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 px-2 py-0.5 rounded border border-sky-200 dark:border-sky-800">
                #{cls.slug} · v{cls.version}
              </span>
              {cls.category && <span className="text-xs text-slate-400">{cls.category}</span>}
            </div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{cls.name}</h2>
            {cls.description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xl">{cls.description}</p>}
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

      {tab === 'predictions' && (
        <ClassScenariosPanel
          equipmentClassSlug={cls.slug}
          availableSignals={availableSignals}
          scenarios={scenariosForClass}
          error={scenariosError}
          onCreate={onCreateScenario}
          onUpdate={onUpdateScenario}
          onPublish={onPublishScenario}
        />
      )}
      {tab === 'alerts' && (
        <ClassAlertTemplatesPanel
          equipmentClassSlug={cls.slug}
          availableSignals={availableSignals}
          templates={alertTemplatesForClass}
          error={alertTemplatesError}
          onCreate={onCreateAlertTemplate}
          onUpdate={onUpdateAlertTemplate}
          onPublish={onPublishAlertTemplate}
          onRetire={onRetireAlertTemplate}
        />
      )}
    </div>
  );
};
