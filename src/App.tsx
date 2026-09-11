/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  NavigationTab,
  AdminSubTab,
  SensorItem,
  ToolMappingItem,
  CategoryItem,
  EquipmentItem,
  DeviceItem,
  PlantItem
} from './types';
import {
  INITIAL_SENSORS,
  INITIAL_TOOL_MAPPINGS,
  INITIAL_CATEGORIES,
  INITIAL_EQUIPMENT,
  INITIAL_DEVICES,
  INITIAL_INDUSTRY_TYPES,
  INITIAL_PROTOCOLS,
  INITIAL_PLANTS,
  INITIAL_ONBOARDING_SESSIONS
} from './data/mockData';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { AskAIWidget } from './components/AskAIWidget';
import { AdminManagement } from './components/admin/AdminManagement';
import { DeviceSetup } from './components/devices/DeviceSetup';
import { AIOnboarding } from './components/onboarding/AIOnboarding';
import { OnboardingList } from './components/onboarding/OnboardingList';
import { EquipmentDetailsView } from './components/onboarding/EquipmentDetailsView';
import {
  DashboardView,
  AlertRulesView,
  VendorsView,
  UsersView,
  DiagnosticsView,
  SettingsView
} from './components/views/OtherViews';
import { PmOverview } from './pm/screens/Overview';
import { PmMachineDetails } from './pm/screens/MachineDetails';
import { PmPredictiveTrends } from './pm/screens/PredictiveTrends';
import { PmActionCenter } from './pm/screens/ActionCenter';
import { PmFuelTheftDetection } from './pm/screens/FuelTheftDetection';
import { PmUtilizationReporting } from './pm/screens/UtilizationReporting';
import { PmGeofencing } from './pm/screens/Geofencing';
import { PmDeviceHealth } from './pm/screens/DeviceHealth';
import { PmReports, ReportsTab } from './pm/screens/Reports';

export default function App() {
  const [currentTab, setCurrentTab] = useState<NavigationTab>('dashboard');
  const [adminSubTab, setAdminSubTab] = useState<AdminSubTab>('sensor');
  const [subRoute, setSubRoute] = useState<'device-setup' | null>(null);
  const [aiOnboardingView, setAiOnboardingView] = useState<'list' | 'chat' | 'equipment-detail'>('list');
  const [isDarkMode, setIsDarkMode] = useState<boolean>(false);

  // Core Data States
  const [sensors, setSensors] = useState<SensorItem[]>(INITIAL_SENSORS);
  const [toolMappings, setToolMappings] = useState<ToolMappingItem[]>(INITIAL_TOOL_MAPPINGS);
  const [categories, setCategories] = useState<CategoryItem[]>(INITIAL_CATEGORIES);
  const [equipmentList, setEquipmentList] = useState<EquipmentItem[]>(INITIAL_EQUIPMENT);
  const [devices, setDevices] = useState<DeviceItem[]>(INITIAL_DEVICES);
  const [industryTypes] = useState(INITIAL_INDUSTRY_TYPES);
  const [protocols] = useState(INITIAL_PROTOCOLS);
  const [plants, setPlants] = useState<PlantItem[]>(INITIAL_PLANTS);
  const [onboardingSessions, setOnboardingSessions] = useState(INITIAL_ONBOARDING_SESSIONS);

  // Predictive Maintenance navigation state
  const [pmSelectedMachineId, setPmSelectedMachineId] = useState<string | null>(null);
  const [pmTrendsPreset, setPmTrendsPreset] = useState<{ machineId?: string; parameterKey?: string }>({});
  const [reportsTab, setReportsTab] = useState<ReportsTab>('operator');

  const handleViewMachine = (machineId: string) => {
    setPmSelectedMachineId(machineId);
    setCurrentTab('pm-machine-details');
  };

  const handleViewTrends = (machineId: string, parameterKey?: string) => {
    setPmTrendsPreset({ machineId, parameterKey });
    setCurrentTab('pm-trends');
  };

  // Sync Dark Mode class on document
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Handlers for Add / Update / Delete
  const handleAddSensor = (newSensor: SensorItem) => {
    setSensors([newSensor, ...sensors]);
  };

  const handleAddToolMapping = (newMapping: ToolMappingItem) => {
    setToolMappings([newMapping, ...toolMappings.filter(t => t.id !== newMapping.id)]);
  };

  const handleAddCategory = (newCat: CategoryItem) => {
    setCategories([newCat, ...categories]);
  };

  const handleUpdateCategory = (updatedCat: CategoryItem) => {
    setCategories(categories.map(c => c.id === updatedCat.id ? updatedCat : c));
  };

  const handleDeleteCategory = (id: string) => {
    setCategories(categories.filter(c => c.id !== id));
  };

  const handleAddEquipment = (newEquip: EquipmentItem) => {
    setEquipmentList([newEquip, ...equipmentList]);
  };

  const handleAddPlant = (newPlant: PlantItem) => {
    setPlants([newPlant, ...plants]);
  };

  const handleAddDevice = (newDevice: DeviceItem) => {
    setDevices([newDevice, ...devices]);
    setSubRoute(null);
    setCurrentTab('admin');
    setAdminSubTab('devices');
  };

  const handleDeleteDevice = (id: number) => {
    setDevices(devices.filter(d => d.id !== id));
  };

  const handleToggleOnboardingActive = (id: string) => {
    setOnboardingSessions(onboardingSessions.map(s => s.id === id ? { ...s, active: !s.active } : s));
  };

  const handleRefreshOnboardingSession = (id: string) => {
    setOnboardingSessions(onboardingSessions.map(s => s.id === id ? { ...s, updatedAt: 'Just now' } : s));
  };

  const handleContinueOnboardingSession = () => {
    setAiOnboardingView('chat');
  };

  const handleViewOnboardingSession = () => {
    setAiOnboardingView('equipment-detail');
  };

  // Compute Page Header Titles based on active view
  let headerTitle = 'Admin';
  let headerSubtitle: string | undefined = 'Master Configuration';
  let headerBreadcrumb: string | undefined = undefined;
  let onBackHandler: (() => void) | undefined = undefined;
  let headerAIIndicator = false;

  if (subRoute === 'device-setup') {
    headerTitle = 'Device Setup';
    headerSubtitle = 'Simplified Setup';
    headerBreadcrumb = 'Device Management';
    onBackHandler = () => setSubRoute(null);
  } else {
    switch (currentTab) {
      case 'admin':
        headerTitle = 'Admin';
        headerSubtitle = 'Master Configuration';
        break;
      case 'ai-onboarding':
        if (aiOnboardingView === 'chat') {
          headerTitle = 'ChatBot Assistant';
          headerSubtitle = 'AI Setup Assistant';
          headerBreadcrumb = 'AI Onboarding';
          onBackHandler = () => setAiOnboardingView('list');
          headerAIIndicator = true;
        } else if (aiOnboardingView === 'equipment-detail') {
          headerTitle = 'Equipment Details';
          headerSubtitle = undefined;
          headerBreadcrumb = 'AI Onboarding';
          onBackHandler = () => setAiOnboardingView('list');
        } else {
          headerTitle = 'AI Onboarding';
          headerSubtitle = 'Guided Setup Sessions';
        }
        break;
      case 'dashboard':
        headerTitle = 'Dashboard';
        headerSubtitle = 'Fleet Telematics';
        break;
      case 'alert-rules':
        headerTitle = 'Alert Rules';
        headerSubtitle = undefined;
        break;
      case 'alert-agent':
        headerTitle = 'Alert Agent';
        headerSubtitle = 'Automated Dispatch';
        break;
      case 'vendors':
        headerTitle = 'Vendors';
        headerSubtitle = 'Hardware OEM Gateways';
        break;
      case 'users':
        headerTitle = 'Users';
        headerSubtitle = 'Access & Permissions';
        break;
      case 'administrator':
        headerTitle = 'Administrator';
        headerSubtitle = 'Root Permissions';
        break;
      case 'diagnostics':
        headerTitle = 'Diagnostics';
        headerSubtitle = 'CAN & MODBUS Bus';
        break;
      case 'settings':
        headerTitle = 'Settings';
        headerSubtitle = 'System Parameters';
        break;
      case 'pm-overview':
        headerTitle = 'Overview';
        headerSubtitle = 'Predictive Maintenance';
        break;
      case 'pm-machine-details':
        headerTitle = 'Machine Details';
        headerSubtitle = undefined;
        headerBreadcrumb = 'Predictive Maintenance';
        onBackHandler = () => setCurrentTab('pm-overview');
        break;
      case 'pm-trends':
        headerTitle = 'Predictive Trends';
        headerSubtitle = 'Deep Signal Analysis';
        headerBreadcrumb = 'Predictive Maintenance';
        break;
      case 'pm-action-center':
        headerTitle = 'Action Center';
        headerSubtitle = 'Maintenance Queue';
        headerBreadcrumb = 'Predictive Maintenance';
        break;
      case 'mon-fuel-theft':
        headerTitle = 'Fuel Theft Detection';
        headerSubtitle = undefined;
        headerBreadcrumb = 'Monitoring';
        break;
      case 'mon-utilization':
        headerTitle = 'Utilization Reporting';
        headerSubtitle = undefined;
        headerBreadcrumb = 'Monitoring';
        break;
      case 'mon-geofencing':
        headerTitle = 'Geofencing';
        headerSubtitle = undefined;
        headerBreadcrumb = 'Monitoring';
        break;
      case 'mon-device-health':
        headerTitle = 'Device Health';
        headerSubtitle = 'Telematics Device Fleet';
        headerBreadcrumb = 'Monitoring';
        break;
      case 'reports':
        headerTitle = 'Reports';
        headerSubtitle = undefined;
        break;
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F4F7FB] dark:bg-slate-950 font-sans text-slate-800 dark:text-slate-100 transition-colors selection:bg-[#0B7285] selection:text-white">
      {/* Left Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={(tab) => {
          setSubRoute(null);
          setAiOnboardingView('list');
          setCurrentTab(tab);
        }}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#F4F7FB] dark:bg-slate-950">
        {/* Top Header */}
        <Header 
          title={headerTitle}
          subtitle={headerSubtitle}
          breadcrumb={headerBreadcrumb}
          onBack={onBackHandler}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
          aiIndicator={headerAIIndicator}
        />

        {/* Dynamic Page Views Container */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8 bg-[#F4F7FB] dark:bg-slate-950">
          <div className="max-w-7xl mx-auto space-y-6">
            
            {subRoute === 'device-setup' ? (
              <DeviceSetup
                onBack={() => setSubRoute(null)}
                onSaveDevice={handleAddDevice}
                toolMappings={toolMappings}
                sensors={sensors}
                categories={categories}
                plants={plants}
              />
            ) : (
              <>
                {currentTab === 'admin' && (
                  <AdminManagement
                    sensors={sensors}
                    toolMappings={toolMappings}
                    categories={categories}
                    industryTypes={industryTypes}
                    protocols={protocols}
                    plants={plants}
                    totalEquipmentCount={equipmentList.length}
                    onAddSensor={handleAddSensor}
                    onAddToolMapping={handleAddToolMapping}
                    onAddCategory={handleAddCategory}
                    onUpdateCategory={handleUpdateCategory}
                    onDeleteCategory={handleDeleteCategory}
                    onAddPlant={handleAddPlant}
                    devices={devices}
                    onNavigateToDeviceSetup={() => setSubRoute('device-setup')}
                    onNavigateToAISetup={() => { setAiOnboardingView('chat'); setCurrentTab('ai-onboarding'); }}
                    onDeleteDevice={handleDeleteDevice}
                    equipmentList={equipmentList}
                    onAddEquipment={handleAddEquipment}
                    activeSubTab={adminSubTab}
                    onChangeSubTab={setAdminSubTab}
                  />
                )}

                {currentTab === 'dashboard' && (
                  <DashboardView
                    equipment={equipmentList}
                    devices={devices}
                    onNavigateToDevices={() => { setCurrentTab('admin'); setAdminSubTab('devices'); }}
                    onNavigateToEquipment={() => { setCurrentTab('admin'); setAdminSubTab('equipment'); }}
                    onNavigate={setCurrentTab}
                    onViewMachine={handleViewMachine}
                  />
                )}

                {currentTab === 'ai-onboarding' && (
                  aiOnboardingView === 'list' ? (
                    <OnboardingList
                      sessions={onboardingSessions}
                      onAddNew={() => setAiOnboardingView('chat')}
                      onViewSession={handleViewOnboardingSession}
                      onEditSession={handleContinueOnboardingSession}
                      onToggleActive={handleToggleOnboardingActive}
                      onRefreshSession={handleRefreshOnboardingSession}
                    />
                  ) : aiOnboardingView === 'equipment-detail' ? (
                    <EquipmentDetailsView />
                  ) : (
                    <AIOnboarding
                      onSkipToManualSetup={() => {
                        setCurrentTab('admin');
                        setAdminSubTab('devices');
                        setSubRoute('device-setup');
                      }}
                    />
                  )
                )}

                {currentTab === 'alert-rules' && <AlertRulesView />}
                {currentTab === 'alert-agent' && <AlertRulesView />}
                {currentTab === 'vendors' && <VendorsView />}
                {currentTab === 'users' && <UsersView />}
                {currentTab === 'administrator' && <UsersView />}
                {currentTab === 'diagnostics' && <DiagnosticsView />}
                {currentTab === 'settings' && <SettingsView />}

                {/* Predictive Maintenance */}
                {currentTab === 'pm-overview' && (
                  <PmOverview onViewMachine={handleViewMachine} />
                )}
                {currentTab === 'pm-machine-details' && (
                  <PmMachineDetails
                    machineId={pmSelectedMachineId ?? undefined}
                    onBack={() => setCurrentTab('pm-overview')}
                    onViewTrends={handleViewTrends}
                  />
                )}
                {currentTab === 'pm-trends' && (
                  <PmPredictiveTrends
                    initialMachineId={pmTrendsPreset.machineId}
                    initialParameterKey={pmTrendsPreset.parameterKey}
                    onViewMachine={handleViewMachine}
                  />
                )}
                {currentTab === 'pm-action-center' && (
                  <PmActionCenter onViewMachine={handleViewMachine} />
                )}

                {/* Monitoring */}
                {currentTab === 'mon-fuel-theft' && <PmFuelTheftDetection />}
                {currentTab === 'mon-utilization' && <PmUtilizationReporting />}
                {currentTab === 'mon-geofencing' && <PmGeofencing />}
                {currentTab === 'mon-device-health' && <PmDeviceHealth />}

                {/* Reports */}
                {currentTab === 'reports' && (
                  <PmReports activeTab={reportsTab} onChangeTab={setReportsTab} />
                )}
              </>
            )}

          </div>
        </main>
      </div>

      {/* Floating Ask AI & Help Widget — hidden on the ChatBot Assistant page, which is already an AI chat */}
      {!(currentTab === 'ai-onboarding' && aiOnboardingView === 'chat') && <AskAIWidget />}
    </div>
  );
}
