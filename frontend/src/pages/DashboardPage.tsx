import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ClientAccount, DeviceItem, EquipmentItem, OnboardingSessionItem, TemplateAlertRule } from '../types';
import { EquipmentTemplate, Sensor } from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { MasterAdminDashboard } from '../components/dashboard/MasterAdminDashboard';
import { ClientFleetDashboard } from '../components/dashboard/ClientFleetDashboard';

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
  const navigate = useNavigate();
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

  // Same screen as "Prediction" — a fleet overview by equipment class, not a
  // separate concept. Doubles as the entry point into the client's own
  // Equipment Templates (their own classes are clickable; the Master Library
  // is reference-only here, same as on the Equipment Templates tab itself).
  return (
    <ClientFleetDashboard
      masterTemplates={masterEquipmentTemplates}
      myTemplates={myEquipmentTemplates}
      templateSensorLinks={templateSensorLinks}
      myTemplateSensorLinks={myTemplateSensorLinks}
      alertRules={alertRules}
      myAlertRules={myAlertRules}
      allSensors={realSensors}
      onOpenTemplate={(templateId) => navigate(`/admin/equipment-template/${templateId}`)}
    />
  );
};
