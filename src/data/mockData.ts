import {
  SensorItem,
  ToolMappingItem,
  CategoryItem,
  EquipmentItem,
  DeviceItem,
  IndustryTypeItem,
  ProtocolItem,
  PlantItem,
  OnboardingSessionItem
} from '../types';

export const INITIAL_SENSORS: SensorItem[] = [
  {
    id: 'SN-CBM-001',
    industryType: 'Cement & Building Materials',
    sensorName: 'Dust_Collector_Monitoring',
    code: 'DCM-01',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Optical opacity, differential pressure transducer, and exhaust baghouse flow telemetry.',
    parameters: ['Differential Pressure', 'Opacity Percentage', 'Exhaust Flow Rate'],
    protocol: 'MODBUS TCP'
  },
  {
    id: 'SN-CBM-002',
    industryType: 'Cement & Building Materials',
    sensorName: 'Conveyor_Monitoring',
    code: 'CV-02',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Conveyor belt speed slip, side-travel misalignment, and pulley vibration sensing.',
    parameters: ['Belt Speed', 'Misalignment Angle', 'Bearing Temp', 'Pulley Vibration'],
    protocol: 'EtherNet / IP'
  },
  {
    id: 'SN-CBM-003',
    industryType: 'Cement & Building Materials',
    sensorName: 'Crusher_Monitoring',
    code: 'CR-03',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Gyratory and jaw crusher mantle load, hydraulic lube oil temperature, and eccentric shaft RPM.',
    parameters: ['Lube Oil Temp', 'Hydraulic Pressure', 'Chamber Load', 'Eccentric RPM'],
    protocol: 'MODBUS RTU'
  },
  {
    id: 'SN-CBM-004',
    industryType: 'Cement & Building Materials',
    sensorName: 'Cement_Mill_Monitoring',
    code: 'CMM-04',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Ball mill trunnion bearing temperature, acoustic impact noise, and pinion gear vibration.',
    parameters: ['Peak Velocity (mm/s)', 'RMS Acceleration (g)', 'Bearing Surface Temp'],
    protocol: 'MODBUS TCP'
  },
  {
    id: 'SN-TRN-005',
    industryType: 'Transport',
    sensorName: 'Tire_Monitoring',
    code: 'TPMS-05',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Direct tire pressure monitoring system (TPMS) with internal carcass temperature sensing.',
    parameters: ['Tire Pressure (PSI)', 'Tire Temp (°C)', 'Leak Detection Rate'],
    protocol: 'CAN-bus / J1939'
  },
  {
    id: 'SN-TRN-006',
    industryType: 'Transport',
    sensorName: 'Vehicle_Condition_Monitoring',
    code: 'VCM-06',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Brake lining wear, transmission fluid condition, and axle vibration telemetry.',
    parameters: ['Brake Pad Wear (%)', 'Transmission Temp (°C)', 'Axle Acceleration'],
    protocol: 'J1939 CAN'
  },
  {
    id: 'SN-TRN-007',
    industryType: 'Transport',
    sensorName: 'Fuel_Monitoring',
    code: 'FM-07',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Capacitive fuel level probe, ultrasonic fuel theft detection, and instant burn rate.',
    parameters: ['Fuel Level (L)', 'Burn Rate (L/hr)', 'Theft Event Flag', 'Return Line Temp'],
    protocol: 'Analog / RS485'
  },
  {
    id: 'SN-TRN-008',
    industryType: 'Transport',
    sensorName: 'Vehicle_Telematics',
    code: 'VT-08',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'GPS/GLONASS precision positioning, 6-axis IMU rollover/harsh braking detection.',
    parameters: ['Latitude', 'Longitude', 'Harsh Acceleration', 'Cornering G-Force'],
    protocol: 'J1939 Telematics'
  },
  {
    id: 'SN-AUT-009',
    industryType: 'Automotive',
    sensorName: 'Welding_Machine_Monitoring',
    code: 'WM-09',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Spot welding tip current, electrode cooling water flow rate, and welding force sensor.',
    parameters: ['Weld Current (kA)', 'Electrode Flow (L/min)', 'Clamping Force (kN)'],
    protocol: 'PROFINET'
  },
  {
    id: 'SN-AUT-010',
    industryType: 'Automotive',
    sensorName: 'Robotic_Assembly_Monitoring',
    code: 'RAM-10',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: '6-axis articulated robot joint torque, servo temperature, and tool center point deviation.',
    parameters: ['Joint 1-6 Torque (Nm)', 'Servo Temp (°C)', 'TCP Accuracy (mm)'],
    protocol: 'EtherNet / IP'
  },
  {
    id: 'SN-PWR-011',
    industryType: 'Power & Energy',
    sensorName: 'Turbine_Vibration_Sensing',
    code: 'TVS-11',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'High-frequency piezoelectric accelerometer for steam/gas turbine shaft eccentricities.',
    parameters: ['Shaft Runout (μm)', 'Phase Angle (°)', 'Bearing Temp (°C)'],
    protocol: 'MODBUS TCP'
  },
  {
    id: 'SN-PWR-012',
    industryType: 'Power & Energy',
    sensorName: 'Transformer_Dissolved_Gas',
    code: 'DGA-12',
    createdAt: '09-03-2026',
    updatedAt: '09-03-2026',
    description: 'Dissolved gas analysis (DGA) monitoring hydrogen, methane, and acetylene in transformer oil.',
    parameters: ['H2 PPM', 'CH4 PPM', 'C2H2 PPM', 'Moisture in Oil (%)'],
    protocol: 'IEC 61850'
  }
];

export const INITIAL_TOOL_MAPPINGS: ToolMappingItem[] = [
  {
    id: 'TM-01',
    identifier: 'TL-BEML-1001',
    toolName: 'BEML Tool',
    industryType: 'Transport',
    mappedSensors: [
      { id: 'SN-TRN-008', name: 'Vehicle_Telematics', tagColor: 'blue', parameters: ['Latitude', 'Longitude', 'Harsh Acceleration', 'Cornering G-Force'] },
      { id: 'SN-TRN-005', name: 'Tire_Monitoring', tagColor: 'teal', parameters: ['Tire Pressure (PSI)', 'Tire Temp (°C)', 'Leak Detection Rate'] }
    ],
    activeParametersCount: 7,
    protocol: 'J1939 Telematics',
    updatedAt: '09-03-2026'
  },
  {
    id: 'TM-02',
    identifier: 'TL-ITDC-2002',
    toolName: 'ITDC Tool',
    industryType: 'Cement & Building Materials',
    mappedSensors: [
      { id: 'SN-CBM-003', name: 'Crusher_Monitoring', tagColor: 'purple', parameters: ['Lube Oil Temp', 'Hydraulic Pressure', 'Chamber Load', 'Eccentric RPM'] },
      { id: 'SN-CBM-004', name: 'Cement_Mill_Monitoring', tagColor: 'amber', parameters: ['Peak Velocity (mm/s)', 'RMS Acceleration (g)', 'Bearing Surface Temp'] }
    ],
    activeParametersCount: 7,
    protocol: 'MODBUS RTU',
    updatedAt: '09-03-2026'
  },
  {
    id: 'TM-03',
    identifier: 'TL-TMTL-3003',
    toolName: 'TMTL Tool',
    industryType: 'Automotive',
    mappedSensors: [
      { id: 'SN-AUT-009', name: 'Welding_Machine_Monitoring', tagColor: 'rose', parameters: ['Weld Current (kA)', 'Electrode Flow (L/min)', 'Clamping Force (kN)'] },
      { id: 'SN-AUT-010', name: 'Robotic_Assembly_Monitoring', tagColor: 'emerald', parameters: ['Joint 1-6 Torque (Nm)', 'Servo Temp (°C)', 'TCP Accuracy (mm)'] }
    ],
    activeParametersCount: 6,
    protocol: 'EtherNet / IP',
    updatedAt: '09-03-2026'
  }
];

export const INITIAL_CATEGORIES: CategoryItem[] = [
  {
    id: 'cat-1',
    name: 'Infrastructure Earthmovers',
    code: 'CAT-IEM-001',
    engineType: 'Diesel (Internal Combustion)',
    fuelTankCapacityLiters: 400,
    description: 'Heavy-duty crawler excavators, motor graders, and bulldozers deployed for surface leveling, deep excavation, and quarry loading operations.',
    createdAt: '03 Sep 2026',
    active: true,
    equipmentCount: 3
  },
  {
    id: 'cat-2',
    name: 'Flyover Construction Cranes',
    code: 'CAT-FCC-001',
    engineType: 'Liebherr 6-Cylinder Diesel',
    fuelTankCapacityLiters: 550,
    description: 'All-terrain mobile cranes and lattice boom cranes for flyover precast girder lifting and superstructure positioning.',
    createdAt: '03 Sep 2026',
    active: true,
    equipmentCount: 1
  },
  {
    id: 'cat-3',
    name: 'Powertrain Test Benches',
    code: 'CAT-PTB-001',
    engineType: 'Electric Drive (AC/DC)',
    fuelTankCapacityLiters: 0,
    description: 'Dyno test rigs, transmission load simulators, and engine combustion durability testing chambers.',
    createdAt: '03 Sep 2026',
    active: true,
    equipmentCount: 1
  },
  {
    id: 'cat-4',
    name: 'Automotive Robotic Assembly',
    code: 'CAT-ARA-001',
    engineType: 'Electric Drive (AC/DC)',
    fuelTankCapacityLiters: 0,
    description: 'Multi-axis articulated robotic arms for body-in-white spot welding, sealant application, and windshield mounting.',
    createdAt: '03 Sep 2026',
    active: true,
    equipmentCount: 1
  },
  {
    id: 'cat-5',
    name: 'Mining Haulage Fleet',
    code: 'CAT-HT-001',
    engineType: 'Hybrid (Diesel-Electric)',
    fuelTankCapacityLiters: 800,
    description: 'Heavy rigid dump trucks hauling limestone, granite, and overburden from extraction faces to primary crushers.',
    createdAt: '03 Sep 2026',
    active: false,
    equipmentCount: 0
  },
  {
    id: 'cat-6',
    name: 'Excavator Heavy Class',
    code: 'CAT-EXC-056',
    engineType: 'Diesel (Internal Combustion)',
    fuelTankCapacityLiters: 450,
    description: 'Standard and extended-reach crawler excavators equipped with rock breakers, buckets, and hydraulic shears.',
    createdAt: '03 Sep 2026',
    active: false,
    equipmentCount: 0
  },
  {
    id: 'cat-7',
    name: 'Wheel Loader',
    code: 'CAT-002',
    engineType: 'Diesel (Internal Combustion)',
    fuelTankCapacityLiters: 320,
    description: 'Articulated front-end wheel loaders for material stockpile management and batch plant hopper feeding.',
    createdAt: '01 Sep 2026',
    active: true,
    equipmentCount: 2
  },
  {
    id: 'cat-8',
    name: 'Dumpers & Tippers',
    code: 'CAT001',
    engineType: 'Diesel (Internal Combustion)',
    fuelTankCapacityLiters: 280,
    description: 'Multi-axle tippers and dump trucks for transit mix concrete and road aggregate haulage.',
    createdAt: '22 Jun 2026',
    active: true,
    equipmentCount: 4
  },
  {
    id: 'cat-9',
    name: 'Vehicle Assembly Conveyors',
    code: 'CAT-VAC-009',
    engineType: 'Electric Drive',
    fuelTankCapacityLiters: 0,
    description: 'Overhead electrified monorail systems, skid conveyors, and automated guided vehicles on final assembly lines.',
    createdAt: '15 Jun 2026',
    active: true,
    equipmentCount: 1
  },
  {
    id: 'cat-10',
    name: 'Kiln & Mill Auxiliaries',
    code: 'CAT-KMA-010',
    engineType: 'Hydraulic Direct Drive',
    fuelTankCapacityLiters: 150,
    description: 'Rotary kiln drive gears, clinker cooler air blasters, and raw meal pneumatic lift installations.',
    createdAt: '10 Jun 2026',
    active: true,
    equipmentCount: 5
  }
];

export const INITIAL_EQUIPMENT: EquipmentItem[] = [
  {
    id: 17,
    name: 'Dürr Electric Monorail Conveyor',
    description: 'Automated overhead conveyor system for vehicle body and component transportation in final assembly',
    category: 'Vehicle Assembly Conveyors',
    maintPlant: 'Pune Automotive Plant',
    cclNumber: 'CCL-PUN-EMS-001',
    manufacturer: 'Dürr',
    modelNumber: 'EMS Heavy Duty',
    licensePlate: 'MH12CV4821',
    engine: 'Electric Drive',
    status: 'Active',
    onboardStatus: 'Onboarded'
  },
  {
    id: 15,
    name: 'Liebherr LTM 1090-4.2 Mobile Crane',
    description: '90-ton all-terrain mobile crane for flyover girder lifting and bridge construction',
    category: 'Flyover Construction Cranes',
    maintPlant: 'Lucknow Infrastructure Plant',
    cclNumber: 'CCL-LKO-CRANE-001',
    manufacturer: 'Liebherr',
    modelNumber: 'LTM 1090-4.2',
    licensePlate: 'UP32CR5821',
    engine: 'Liebherr 6-Cylinder Diesel',
    status: 'Active',
    onboardStatus: 'Onboarded'
  },
  {
    id: 14,
    name: 'Volvo EC210 Crawler Excavator',
    description: 'Crawler excavator for road construction, excavation and general infrastructure work',
    category: 'Infrastructure Earthmovers',
    maintPlant: 'Lucknow Infrastructure Plant',
    cclNumber: 'CCL-LKO-EC210-003',
    manufacturer: 'Volvo Construction Equipment',
    modelNumber: 'EC210',
    licensePlate: 'UP32CE9136',
    engine: 'Volvo Diesel Engine',
    status: 'Active',
    onboardStatus: 'Onboarded'
  },
  {
    id: 13,
    name: 'Komatsu PC210LC-11 Hydraulic Excavator',
    description: 'Crawler excavator designed for heavy excavation, earthmoving and infrastructure projects',
    category: 'Infrastructure Earthmovers',
    maintPlant: 'Lucknow Infrastructure Plant',
    cclNumber: 'CCL-LKO-PC210-002',
    manufacturer: 'Komatsu',
    modelNumber: 'PC210LC-11',
    licensePlate: 'UP32CE6784',
    engine: 'Diesel',
    status: 'Active',
    onboardStatus: 'Onboarded'
  },
  {
    id: 12,
    name: 'CAT 320 GC Hydraulic Excavator',
    description: 'Medium hydraulic excavator for construction and earthmoving tasks',
    category: 'Infrastructure Earthmovers',
    maintPlant: 'Lucknow Infrastructure Plant',
    cclNumber: 'CCL-LKO-CAT320-001',
    manufacturer: 'Caterpillar',
    modelNumber: '320 GC',
    licensePlate: 'UP32CE4521',
    engine: 'Cat C4.4 ACERT Diesel',
    status: 'Active',
    onboardStatus: 'Onboarded'
  },
  {
    id: 11,
    name: 'JCB 3DX Super Backhoe Loader',
    description: 'Multi-purpose front loading backhoe for trenching, material handling, and site prep',
    category: 'Dumpers & Tippers',
    maintPlant: 'Lucknow Infrastructure Plant',
    cclNumber: 'CCL-LKO-JCB-004',
    manufacturer: 'JCB India',
    modelNumber: '3DX Super',
    licensePlate: 'UP32BC8812',
    engine: 'JCB ecoMAX Diesel',
    status: 'Under Maintenance',
    onboardStatus: 'Onboarded'
  },
  {
    id: 10,
    name: 'Tata Signa 2823.K HD Tipper',
    description: '28-ton Gross Vehicle Weight heavy-duty tipper truck for flyover aggregate haulage',
    category: 'Dumpers & Tippers',
    maintPlant: 'Lucknow Infrastructure Plant',
    cclNumber: 'CCL-LKO-TIP-009',
    manufacturer: 'Tata Motors',
    modelNumber: 'Signa 2823.K',
    licensePlate: 'UP32TD4102',
    engine: 'Cummins ISBe 5.6L Diesel',
    status: 'Active',
    onboardStatus: 'Onboarded'
  },
  {
    id: 9,
    name: 'KUKA KR 500 FORTEC Heavy Robot',
    description: '500kg payload articulated industrial robot arm on powertrain machining cell',
    category: 'Automotive Robotic Assembly',
    maintPlant: 'Pune Automotive Plant',
    cclNumber: 'CCL-PUN-ROB-002',
    manufacturer: 'KUKA AG',
    modelNumber: 'KR 500 R2830',
    licensePlate: 'MH12KB9901',
    engine: 'Electric Drive (AC/DC)',
    status: 'Active',
    onboardStatus: 'Onboarded'
  }
];

export const INITIAL_DEVICES: DeviceItem[] = [
  {
    id: 131,
    name: 'PowerCommand Cloud',
    imei: '356789104590731',
    equipmentName: 'Generator',
    vendor: 'Eicher Motors',
    status: 'Offline',
    toolProfile: 'Heavy Generator Telematics Suite (GenTool v3.2)',
    mappedSensorsCount: 3,
    lastPing: '4 hours ago'
  },
  {
    id: 129,
    name: 'LiveLink',
    imei: '356789104589623',
    equipmentName: 'JCB 3FE',
    vendor: 'JCB India',
    status: 'Online',
    toolProfile: 'HydraSense-X Excavator Rig',
    mappedSensorsCount: 2,
    lastPing: '2 mins ago'
  },
  {
    id: 128,
    name: 'LiDAT-liebherr',
    imei: '356789104587516',
    equipmentName: 'Liebherr LTM 1030-2.1 Mobile Crane',
    vendor: 'Larsen Engineering',
    status: 'Online',
    toolProfile: 'Heavy Crane Telemetry Core',
    mappedSensorsCount: 4,
    lastPing: 'Just now'
  },
  {
    id: 127,
    name: 'FlexLink Web Services (FLWS)',
    imei: '356789104586142',
    equipmentName: 'FlexLink X85P Pallet Conveyor',
    vendor: 'Tata Hitachi',
    status: 'Online',
    toolProfile: 'FlexTrack v1.1 Conveyor Monitor',
    mappedSensorsCount: 2,
    lastPing: '1 min ago'
  },
  {
    id: 126,
    name: 'DXQcontrol',
    imei: '356789104584935',
    equipmentName: 'Dürr Electric Monorail Conveyor',
    vendor: 'Durr pvt lts',
    status: 'Online',
    toolProfile: 'AutoWeld Precision Tracker',
    mappedSensorsCount: 2,
    lastPing: '3 mins ago'
  },
  {
    id: 125,
    name: 'LiDAT',
    imei: '3567891045827745',
    equipmentName: 'Liebherr LTM 1090-4.2 Mobile Crane',
    vendor: 'BEML',
    status: 'Online',
    toolProfile: 'Heavy Crane Telemetry Core',
    mappedSensorsCount: 3,
    lastPing: 'Just now'
  },
  {
    id: 124,
    name: 'CareTrack',
    imei: '356789104582731',
    equipmentName: 'Volvo EC210 Crawler Excavator',
    vendor: 'BEML',
    status: 'Online',
    toolProfile: 'HydraSense-X Excavator Rig',
    mappedSensorsCount: 2,
    lastPing: '4 mins ago'
  },
  {
    id: 123,
    name: 'KOMTRAX',
    imei: '78954163',
    equipmentName: 'Komatsu PC210LC-11 Hydraulic Excavator',
    vendor: 'BEML',
    status: 'Online',
    toolProfile: 'HydraSense-X Excavator Rig',
    mappedSensorsCount: 2,
    lastPing: '2 mins ago'
  }
];

export const INITIAL_INDUSTRY_TYPES: IndustryTypeItem[] = [
  { id: 'ind-1', name: 'Cement & Building Materials', code: 'CBM', totalSensors: 8, totalEquipment: 7, status: 'Active' },
  { id: 'ind-2', name: 'Transport & Fleet', code: 'TRN', totalSensors: 6, totalEquipment: 5, status: 'Active' },
  { id: 'ind-3', name: 'Automotive Manufacturing', code: 'AUT', totalSensors: 5, totalEquipment: 4, status: 'Active' },
  { id: 'ind-4', name: 'Power & Energy', code: 'PWR', totalSensors: 4, totalEquipment: 2, status: 'Active' },
  { id: 'ind-5', name: 'Mining & Aggregates', code: 'MIN', totalSensors: 5, totalEquipment: 3, status: 'Active' }
];

export const INITIAL_PROTOCOLS: ProtocolItem[] = [
  { id: 'prt-1', name: 'MODBUS TCP / RTU', type: 'Industrial Fieldbus', portDefault: 502, baudRate: '19200', devicesCount: 8, status: 'Active' },
  { id: 'prt-2', name: 'CAN-bus / J1939', type: 'Automotive & Heavy Fleet', portDefault: 2939, baudRate: '250k / 500k', devicesCount: 7, status: 'Active' },
  { id: 'prt-3', name: 'EtherNet / IP (CIP)', type: 'Industrial Automation', portDefault: 44818, devicesCount: 4, status: 'Active' },
  { id: 'prt-4', name: 'PROFINET RT', type: 'Deterministic Fieldbus', portDefault: 34964, devicesCount: 3, status: 'Active' },
  { id: 'prt-5', name: 'MQTT / Sparkplug B', type: 'IIoT Edge Gateway', portDefault: 8883, devicesCount: 6, status: 'Active' }
];

export const INITIAL_PLANTS: PlantItem[] = [
  { id: 'plt-1', name: 'Lucknow Infrastructure Plant', location: 'Lucknow, UP', code: 'CCL-LKO', equipmentCount: 9 },
  { id: 'plt-2', name: 'Pune Automotive Plant', location: 'Pune, MH', code: 'CCL-PUN', equipmentCount: 6 },
  { id: 'plt-3', name: 'CBM Central Works', location: 'Chanderiya, RJ', code: 'CCL-CBM', equipmentCount: 8 }
];

export const INITIAL_ONBOARDING_SESSIONS: OnboardingSessionItem[] = [
  {
    id: 'ob-1',
    name: 'Lucknow Infrastructure Onboarding',
    sitesCount: 2,
    equipmentCount: 6,
    status: 'Completed',
    active: true,
    createdAt: '28 Aug 2026',
    updatedAt: '03 Sep 2026'
  },
  {
    id: 'ob-2',
    name: 'Pune Automotive Line Setup',
    sitesCount: 1,
    equipmentCount: 4,
    status: 'In Progress',
    active: true,
    createdAt: '05 Sep 2026',
    updatedAt: '07 Sep 2026'
  }
];
