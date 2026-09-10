export type NavigationTab =
  | 'dashboard'
  | 'ai-onboarding'
  | 'alert-rules'
  | 'alert-agent'
  | 'admin'
  | 'vendors'
  | 'users'
  | 'administrator'
  | 'diagnostics'
  | 'settings';

export type AdminSubTab =
  | 'industry'
  | 'sensor'
  | 'category'
  | 'plant'
  | 'tool-mapping'
  | 'devices'
  | 'equipment';

export interface SensorItem {
  id: string;
  industryType: string;
  sensorName: string;
  code?: string;
  createdAt: string;
  updatedAt: string;
  description?: string;
  parameters?: string[];
  protocol?: string;
}

export interface ToolMappingItem {
  id: string;
  identifier: string;
  toolName: string;
  industryType: string;
  mappedSensors: {
    id: string;
    name: string;
    tagColor: 'blue' | 'teal' | 'purple' | 'amber' | 'rose' | 'emerald';
    parameters: string[];
  }[];
  activeParametersCount: number;
  protocol: string;
  updatedAt: string;
}

export interface CategoryItem {
  id: string;
  name: string;
  code: string;
  engineType: string;
  fuelTankCapacityLiters: number;
  description: string;
  createdAt: string;
  active: boolean;
  equipmentCount: number;
}

export interface EquipmentItem {
  id: number;
  name: string;
  description: string;
  category: string;
  maintPlant: string;
  cclNumber: string;
  manufacturer: string;
  modelNumber: string;
  licensePlate: string;
  engine: string;
  status?: 'Active' | 'Under Maintenance' | 'Idle';
  onboardStatus?: 'Onboarded' | 'Pending';
  partNo?: string;
  serialNo?: string;
  fuelCapacity?: number;
  toolMapping?: string;
  assignedSensors?: string[];
}

export interface DeviceItem {
  id: number;
  name: string;
  imei: string;
  equipmentName: string;
  vendor: string;
  status: 'Online' | 'Offline';
  toolProfile?: string;
  category?: string;
  plant?: string;
  selectedSensors?: string[];
  mappedSensorsCount?: number;
  lastPing?: string;
}

export interface IndustryTypeItem {
  id: string;
  name: string;
  code: string;
  totalSensors: number;
  totalEquipment: number;
  status: 'Active' | 'Inactive';
}

export interface ProtocolItem {
  id: string;
  name: string;
  type: string;
  portDefault: number;
  baudRate?: string;
  devicesCount: number;
  status: 'Active' | 'Inactive';
}

export interface PlantItem {
  id: string;
  name: string;
  location: string;
  code: string;
  equipmentCount: number;
}

export interface OnboardingSessionItem {
  id: string;
  name: string;
  sitesCount: number;
  equipmentCount: number;
  status: 'Completed' | 'In Progress';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
