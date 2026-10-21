import React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RegisterDeviceInput, ToolMapping } from '../lib/api';
import { useAuth } from '../lib/AuthProvider';
import { usePageHeader } from '../lib/PageHeaderContext';
import { RegisterDevicesForm } from '../components/devices/RegisterDevicesForm';

interface DeviceSetupPageProps {
  realToolMappings: ToolMapping[];
  onRegisterDevices: (devices: RegisterDeviceInput[]) => Promise<{ registered: number; alreadyKnown: number }>;
}

export const DeviceSetupPage: React.FC<DeviceSetupPageProps> = ({ realToolMappings, onRegisterDevices }) => {
  const { authUser } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('devices');
  usePageHeader({
    title: t('register.title'),
    subtitle: t('setupPage.subtitle'),
    breadcrumb: t('setupPage.breadcrumb'),
    onBack: () => navigate('/admin/devices'),
  });
  if (!authUser) return null;

  // A client never registers hardware: Things Alive assigns a logger to their account,
  // and they fit it to a machine from that machine's bindings (Administration →
  // Equipment). The old client form here saved a device to page memory only, so it is
  // gone rather than kept beside the real path; a bookmark lands on that path instead.
  if (authUser.role !== 'master-admin') return <Navigate to="/admin/equipment" replace />;

  // Master Admin registers stock by IMEI and an optional tool mapping — assigning it
  // to a client is a separate act from the pool view. Plant/Equipment placement is
  // the client's own claim step and has no place in this form; see DevicePoolManagement.
  return (
    <RegisterDevicesForm
      onBack={() => navigate('/admin/devices')}
      toolMappings={realToolMappings}
      onRegister={onRegisterDevices}
    />
  );
};
