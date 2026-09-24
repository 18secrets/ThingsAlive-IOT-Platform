import React, { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Cpu,
  Check,
  Activity,
  Radio,
  CheckCircle2,
  Layers,
  Info,
  ArrowRight,
  Sparkles,
  SlidersHorizontal,
  Plus
} from 'lucide-react';
import { DeviceItem, ToolMappingItem, SensorItem, CategoryItem, PlantItem, ClientAccount } from '../../types';

interface DeviceSetupProps {
  onBack: () => void;
  onSaveDevice: (device: DeviceItem) => void;
  toolMappings: ToolMappingItem[];
  sensors: SensorItem[];
  categories: CategoryItem[];
  plants: PlantItem[];
  clients: ClientAccount[];
}

export const DeviceSetup: React.FC<DeviceSetupProps> = ({
  onBack,
  onSaveDevice,
  toolMappings,
  sensors,
  categories,
  plants,
  clients,
}) => {
  const [selectedToolId, setSelectedToolId] = useState('');
  const [imei, setImei] = useState('');
  const [selectedPlant, setSelectedPlant] = useState('');
  const [selectedClientId, setSelectedClientId] = useState(clients.length === 1 ? clients[0].id : '');
  const clientLocked = clients.length === 1;

  const [manualProtocol, setManualProtocol] = useState('');
  const [activeSensorNames, setActiveSensorNames] = useState<string[]>([]);
  const [activeParametersMap, setActiveParametersMap] = useState<Record<string, string[]>>({});

  // Plants belonging to the selected client only
  const filteredPlants = useMemo(() => {
    if (!selectedClientId) return [];
    return plants.filter((p) => p.clientId === selectedClientId);
  }, [plants, selectedClientId]);

  // Whenever the Client changes, reset the Plant to the first plant of that client
  useEffect(() => {
    setSelectedPlant(filteredPlants[0]?.name || '');
  }, [selectedClientId, filteredPlants]);

  // The Device Name is always the selected Admin Tool Mapping's Tool Name
  const matchedTool = useMemo(() => {
    return toolMappings.find((t) => t.id === selectedToolId) || null;
  }, [selectedToolId, toolMappings]);

  const deviceName = matchedTool?.toolName || '';

  // Whenever the selected Tool changes, auto-populate (or clear) its sensors and parameters
  useEffect(() => {
    if (matchedTool) {
      const sensorNames = matchedTool.mappedSensors.map((s) => s.name);
      setActiveSensorNames(sensorNames);

      const paramsMap: Record<string, string[]> = {};
      matchedTool.mappedSensors.forEach((s) => {
        paramsMap[s.name] = [...s.parameters];
      });
      setActiveParametersMap(paramsMap);
    } else {
      setActiveSensorNames([]);
      setActiveParametersMap({});
    }
  }, [matchedTool]);

  // Handle manual or custom toggle of a sensor
  const handleToggleSensor = (sensor: SensorItem) => {
    const sName = sensor.sensorName;
    const isCurrentlyActive = activeSensorNames.includes(sName);

    if (isCurrentlyActive) {
      // Remove sensor and its parameters
      setActiveSensorNames((prev) => prev.filter((s) => s !== sName));
      setActiveParametersMap((prev) => {
        const next = { ...prev };
        delete next[sName];
        return next;
      });
    } else {
      // Add sensor and include its default parameters from sensor catalog
      setActiveSensorNames((prev) => [...prev, sName]);
      setActiveParametersMap((prev) => ({
        ...prev,
        [sName]: sensor.parameters ? [...sensor.parameters] : [],
      }));
    }
  };

  // Handle manual toggle of a parameter channel for an active sensor
  const handleToggleParameter = (sensorName: string, paramName: string) => {
    setActiveParametersMap((prev) => {
      const currentParams = prev[sensorName] || [];
      const updated = currentParams.includes(paramName)
        ? currentParams.filter((p) => p !== paramName)
        : [...currentParams, paramName];
      return {
        ...prev,
        [sensorName]: updated,
      };
    });
  };

  // Select all sensors manually
  const handleSelectAllSensors = () => {
    const allNames = sensors.map((s) => s.sensorName);
    setActiveSensorNames(allNames);
    const pMap: Record<string, string[]> = {};
    sensors.forEach((s) => {
      pMap[s.sensorName] = s.parameters ? [...s.parameters] : [];
    });
    setActiveParametersMap(pMap);
  };

  // Clear all sensors manually
  const handleClearAllSensors = () => {
    setActiveSensorNames([]);
    setActiveParametersMap({});
  };

  // Compute total active parameter channels
  const totalActiveParameters = useMemo(() => {
    return Object.keys(activeParametersMap).reduce((acc, key) => {
      const p = activeParametersMap[key];
      return acc + (Array.isArray(p) ? p.length : 0);
    }, 0);
  }, [activeParametersMap]);

  const effectiveProtocol = matchedTool ? matchedTool.protocol : manualProtocol;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const selectedClientAccount = clients.find((c) => c.id === selectedClientId);
    if (!matchedTool || !imei || !selectedClientAccount) return;

    const newDevice: DeviceItem = {
      id: Math.floor(132 + Math.random() * 50),
      name: matchedTool.toolName,
      imei: imei.trim(),
      status: 'Online',
      toolProfile: matchedTool.toolName,
      plant: selectedPlant,
      selectedSensors: activeSensorNames,
      mappedSensorsCount: activeSensorNames.length,
      lastPing: 'Just now',
      clientId: selectedClientAccount.id,
      clientName: selectedClientAccount.clientName,
    };

    onSaveDevice(newDevice);
  };

  return (
    <div id="device-setup-view" className="space-y-6 max-w-4xl mx-auto" data-purpose="device-setup-page">
      
      {/* Top Breadcrumb & Action */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-xs font-semibold text-slate-600 hover:text-sky-600 dark:text-slate-400 dark:hover:text-sky-400 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Device Management</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="px-2.5 py-0.5 bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300 text-xs font-medium rounded border border-sky-200 dark:border-sky-800">
            Admin Master Data Bound
          </span>
          <span className="text-xs text-slate-400">Step 1 of 1 • Onboarding</span>
        </div>
      </div>

      {/* Main Setup Card */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs overflow-hidden">
        
        {/* Card Header with Simplified Setup Badge */}
        <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                Device Onboarding & Admin Configuration
              </h2>
              <span className="px-2 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium text-xs rounded border border-slate-200 dark:border-slate-700">
                Strict Schema
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-sans">
              Plants, Categories, Tool Mappings, and Sensors in this form are drawn strictly from the Admin configuration.
            </p>
          </div>

          <div className="w-9 h-9 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-400 flex items-center justify-center shrink-0">
            <Cpu className="w-5 h-5" />
          </div>
        </div>

        {/* Master Catalog Indicators */}
        <div className="px-6 py-2.5 bg-slate-50 dark:bg-slate-800/30 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between flex-wrap gap-2 text-xs text-slate-600 dark:text-slate-400">
          <div className="flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-sky-600" />
            <span>Admin Data Source: <strong className="text-slate-700 dark:text-slate-300">{plants.length} Plants</strong> • <strong className="text-slate-700 dark:text-slate-300">{categories.length} Categories</strong> • <strong className="text-slate-700 dark:text-slate-300">{toolMappings.length} Tool Mappings</strong> • <strong className="text-slate-700 dark:text-slate-300">{sensors.length} Sensors</strong></span>
          </div>
          <span className="text-xs text-sky-600 dark:text-sky-400 font-medium">Live Synchronized</span>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-sm font-sans">
            {/* Client */}
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Client <span className="text-rose-500">*</span>
              </label>
              <select
                required
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
                disabled={clientLocked}
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer disabled:bg-slate-50 dark:disabled:bg-slate-800/40 disabled:cursor-not-allowed"
              >
                <option value="" disabled>Select a client</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.clientName}</option>
                ))}
              </select>
            </div>

            {/* Tool Name (from Admin Tool Mappings) — this becomes the Device Name */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Tool Name <span className="text-rose-500">*</span>
                </label>
                {matchedTool && (
                  <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Sensors auto-loaded</span>
                  </span>
                )}
              </div>
              <select
                required
                value={selectedToolId}
                onChange={(e) => setSelectedToolId(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer"
              >
                <option value="" disabled>Select a tool mapping</option>
                {toolMappings.map((tool) => (
                  <option key={tool.id} value={tool.id}>
                    {tool.toolName} ({tool.identifier}) - {tool.protocol}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-slate-400 mt-1">
                The Device Name is set to the selected Tool Name; its mapped sensors and parameters auto-populate below.
              </p>
            </div>

            {/* IMEI / Hardware Serial */}
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                IMEI / Hardware Serial Number <span className="text-rose-500">*</span>
              </label>
              <input 
                type="text" 
                required
                value={imei}
                onChange={(e) => setImei(e.target.value)}
                placeholder="15-digit unique cellular hardware IMEI" 
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 transition-colors font-mono"
              />
            </div>

            {/* Plant Dropdown (Strictly from Admin Plants belonging to the selected Client) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Plant (from Admin) <span className="text-rose-500">*</span>
                </label>
                <span className="text-[11px] text-sky-600 font-medium">Admin Only</span>
              </div>
              <select
                value={selectedPlant}
                onChange={(e) => setSelectedPlant(e.target.value)}
                required
                disabled={!selectedClientId}
                className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:border-sky-500 cursor-pointer disabled:bg-slate-50 dark:disabled:bg-slate-800/40 disabled:cursor-not-allowed"
              >
                {!selectedClientId ? (
                  <option value="">Select a client first</option>
                ) : filteredPlants.length === 0 ? (
                  <option value="">No plants configured for this client</option>
                ) : (
                  filteredPlants.map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name} ({p.location})
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          {/* Tool Mapping Match (driven by the selected Tool Name) */}
          <div className="pt-5 border-t border-slate-200 dark:border-slate-800 space-y-3">
            {/* MATCHED CASE: Show the tool mapping sensors and parameters info */}
            {matchedTool ? (
              <div className="p-4 bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 rounded-lg space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">
                      Matched Tool Profile: {matchedTool.toolName}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 rounded">
                      ID: {matchedTool.identifier}
                    </span>
                    <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 rounded">
                      Protocol: {matchedTool.protocol}
                    </span>
                  </div>
                </div>

                <p className="text-xs text-slate-600 dark:text-slate-300">
                  The Device Name is set from this Admin Tool Mapping. Its mapped sensors and telemetry parameters have been auto-populated below:
                </p>

                {/* Breakdown of mapped sensors & parameters info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-1">
                  {matchedTool.mappedSensors.map((s) => (
                    <div 
                      key={s.id}
                      className="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg flex flex-col justify-between"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-medium text-xs text-slate-800 dark:text-slate-100">
                          {s.name}
                        </span>
                        <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 px-1.5 py-0.5 rounded">
                          {s.parameters.length} Channels
                        </span>
                      </div>

                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.parameters.map((param) => (
                          <span 
                            key={param}
                            className="px-1.5 py-0.5 text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded border border-slate-200 dark:border-slate-700"
                          >
                            {param}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* UNSELECTED CASE: No tool chosen yet, user selects manually */
              <div className="p-4 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 rounded-lg flex items-start gap-3">
                <Info className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
                <div className="text-xs">
                  <div className="font-semibold text-slate-800 dark:text-slate-200">
                    No Tool Selected
                  </div>
                  <p className="text-slate-500 dark:text-slate-400 mt-1">
                    Sensors and parameters are currently empty. Please select sensors and configure telemetry channels manually from the catalog below.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Active Sensors & Parameters Catalog (Manual or Auto-selected) */}
          <div className="p-5 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-lg space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 text-slate-800 dark:text-slate-100 font-semibold text-sm">
                <Activity className="w-4 h-4 text-sky-600" />
                <span>Assigned Sensors & Parameter Channels</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-xs rounded border border-slate-200 dark:border-slate-700 font-medium">
                  {activeSensorNames.length} of {sensors.length} Connected • {totalActiveParameters} Parameters
                </span>
                {!matchedTool && (
                  <div className="flex items-center gap-1 text-xs">
                    <button
                      type="button"
                      onClick={handleSelectAllSensors}
                      className="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-slate-700 dark:text-slate-300"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={handleClearAllSensors}
                      className="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-slate-700 dark:text-slate-300"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Empty state notice if zero sensors are selected */}
            {activeSensorNames.length === 0 ? (
              <div className="py-8 text-center border border-dashed border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900">
                <Activity className="w-6 h-6 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  No Sensors or Parameters Selected
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                  Sensors are empty because no Tool Name has been selected above. Click any sensor below to manually assign it and its parameters.
                </p>
              </div>
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {matchedTool 
                  ? `Showing sensors and parameters loaded from ${matchedTool.toolName}. Click any sensor to toggle or fine-tune channels:`
                  : 'Sensors selected manually. Click any sensor to toggle or customize parameter channels:'}
              </p>
            )}

            {/* Grid of Admin Sensors with Interactive Parameter Badges */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-72 overflow-y-auto pr-1">
              {sensors.map((sensor) => {
                const isActive = activeSensorNames.includes(sensor.sensorName);
                const activeParamsForSensor = activeParametersMap[sensor.sensorName] || [];

                return (
                  <div 
                    key={sensor.id}
                    className={`p-3 rounded-lg border transition-all flex flex-col justify-between ${
                      isActive 
                        ? 'bg-sky-50/50 dark:bg-sky-950/20 border-sky-300 dark:border-sky-800 shadow-xs' 
                        : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800 hover:border-slate-300'
                    }`}
                  >
                    <div>
                      {/* Sensor Header Button */}
                      <button
                        type="button"
                        onClick={() => handleToggleSensor(sensor)}
                        className="w-full text-left flex items-center justify-between mb-1 cursor-pointer"
                      >
                        <span className="font-medium text-xs text-slate-800 dark:text-slate-200 truncate max-w-[170px]" title={sensor.sensorName}>
                          {sensor.sensorName}
                        </span>
                        {isActive ? (
                          <div className="w-4 h-4 bg-sky-600 text-white rounded flex items-center justify-center text-xs shrink-0">
                            <Check className="w-3 h-3" />
                          </div>
                        ) : (
                          <span className="w-4 h-4 rounded border border-slate-300 dark:border-slate-600 shrink-0 inline-block" />
                        )}
                      </button>

                      <div className="text-[10px] text-slate-400 truncate mb-2">
                        {sensor.category || sensor.industryType || 'Uncategorized'} • {sensor.protocol || 'MODBUS'}
                      </div>
                    </div>

                    {/* Sensor Parameters Chips */}
                    {sensor.parameters && sensor.parameters.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
                        <div className="text-[10px] text-slate-400 uppercase flex items-center justify-between font-medium">
                          <span>Parameters</span>
                          {isActive && (
                            <span className="text-sky-600 dark:text-sky-400">{activeParamsForSensor.length}/{sensor.parameters.length} Active</span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {sensor.parameters.map((param) => {
                            const isParamActive = activeParamsForSensor.includes(param);
                            return (
                              <button
                                key={param}
                                type="button"
                                onClick={() => {
                                  if (!isActive) {
                                    handleToggleSensor(sensor);
                                  } else {
                                    handleToggleParameter(sensor.sensorName, param);
                                  }
                                }}
                                className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors cursor-pointer ${
                                  isActive && isParamActive
                                    ? 'bg-sky-600 text-white border-sky-600'
                                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300'
                                }`}
                              >
                                {param}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Protocol & Communication Info */}
            <div className="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg flex items-center justify-between flex-wrap gap-2 text-xs text-slate-600 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <Radio className="w-3.5 h-3.5 text-sky-600" />
                <span>
                  Communication Protocol: <strong className="font-semibold text-slate-800 dark:text-slate-200">{effectiveProtocol}</strong>
                </span>
                {!matchedTool && (
                  <select
                    value={manualProtocol}
                    onChange={(e) => setManualProtocol(e.target.value)}
                    className="ml-2 px-2 py-0.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-xs cursor-pointer text-slate-700 dark:text-slate-300"
                  >
                    <option value="">Select protocol</option>
                    <option value="MODBUS TCP">MODBUS TCP</option>
                    <option value="CAN Bus (J1939)">CAN Bus (J1939)</option>
                    <option value="MQTT / TLS">MQTT / TLS</option>
                    <option value="RS-485 Modbus RTU">RS-485 Modbus RTU</option>
                  </select>
                )}
              </div>
              <span className="text-slate-400">Sampling: 1 Hz Real-time Continuous</span>
            </div>
          </div>

          {/* Action Buttons matching screenshot theme */}
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onBack}
              className="px-4 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-[#0B7285] hover:bg-[#095C6B] text-white rounded-lg text-sm font-medium shadow-xs flex items-center gap-2 transition-colors cursor-pointer"
            >
              <span>Create Device</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
