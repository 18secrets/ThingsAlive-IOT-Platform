import React from 'react';
import { ClientAccount, DeviceItem, EquipmentItem, OnboardingSessionItem, TemplateAlertRule } from '../types';
import { EquipmentTemplate, Sensor } from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { MasterAdminDashboard } from '../components/dashboard/MasterAdminDashboard';
import { EnterpriseCommandCenter } from '../components/dashboard/EnterpriseCommandCenter';

interface DashboardPageProps {
  clients: ClientAccount[];
  devices: DeviceItem[];
  equipmentList: EquipmentItem[];
  onboardingSessions: OnboardingSessionItem[];
  masterEquipmentTemplates: EquipmentTemplate[];
  myEquipmentTemplates: EquipmentTemplate[];
  templateSensorLinks: Record<string, string[]>;
  myTemplateSensorLinks: Record<string, string[]>;
  alertRules: TemplateAlertRule[];
  myAlertRules: TemplateAlertRule[];
  realSensors: Sensor[];
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  clients, devices, equipmentList, onboardingSessions,
  masterEquipmentTemplates, myEquipmentTemplates, templateSensorLinks, myTemplateSensorLinks,
  alertRules, myAlertRules, realSensors,
}) => {
  const { authUser } = useAuth();
  if (!authUser) return null;

  if (authUser.role === 'master-admin') {
    return (
      <MasterAdminDashboard
        clients={clients}
        devices={devices}
        equipmentList={equipmentList}
        onboardingSessions={onboardingSessions}
      />
    );
  }

  // UI-only mock fleet view (see src/data/fleetMockData.ts) — not yet backed
  // by the real equipment-template props this page still receives for the
  // master-admin branch above.
  return <EnterpriseCommandCenter />;
};
