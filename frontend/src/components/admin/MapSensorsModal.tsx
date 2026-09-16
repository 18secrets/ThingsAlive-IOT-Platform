import React, { useState, useEffect } from 'react';
import { X, Check, Radio, Activity, Layers } from 'lucide-react';
import { ToolMappingItem, SensorItem } from '../../types';

interface MapSensorsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (mapping: ToolMappingItem) => void;
  existingMapping?: ToolMappingItem | null;
  availableSensors?: SensorItem[];
}

export const MapSensorsModal: React.FC<MapSensorsModalProps> = ({
  isOpen,
  onClose,
  onSave,
  existingMapping,
  availableSensors = [],
}) => {
  const [toolName, setToolName] = useState(existingMapping?.toolName || 'Heavy Excavation Monitoring Kit (HE-400)');
  const [industryType, setIndustryType] = useState(existingMapping?.industryType || 'Cement & Building Materials');

  // Track which sensor IDs are active and their active parameter lists
  const [activeSensorMap, setActiveSensorMap] = useState<Record<string, boolean>>({});
  const [activeParamsMap, setActiveParamsMap] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (existingMapping) {
      setToolName(existingMapping.toolName);
      setIndustryType(existingMapping.industryType);

      const sMap: Record<string, boolean> = {};
      const pMap: Record<string, string[]> = {};
      existingMapping.mappedSensors.forEach(s => {
        sMap[s.name] = true;
        pMap[s.name] = [...s.parameters];
      });
      setActiveSensorMap(sMap);
      setActiveParamsMap(pMap);
    } else if (availableSensors.length > 0) {
      // Default: activate first 2 sensors from Admin
      const sMap: Record<string, boolean> = {};
      const pMap: Record<string, string[]> = {};
      availableSensors.slice(0, 2).forEach(s => {
        sMap[s.sensorName] = true;
        pMap[s.sensorName] = s.parameters ? [...s.parameters] : ['Telemetry Channel 1'];
      });
      setActiveSensorMap(sMap);
      setActiveParamsMap(pMap);
    }
  }, [existingMapping, availableSensors, isOpen]);

  if (!isOpen) return null;

  const toggleSensor = (sensorName: string, defaultParams: string[] = []) => {
    setActiveSensorMap(prev => {
      const nextActive = !prev[sensorName];
      if (nextActive && !activeParamsMap[sensorName]) {
        setActiveParamsMap(p => ({
          ...p,
          [sensorName]: defaultParams.length > 0 ? [...defaultParams] : ['Telemetry Channel 1']
        }));
      }
      return { ...prev, [sensorName]: nextActive };
    });
  };

  const toggleParam = (sensorName: string, param: string) => {
    setActiveParamsMap(prev => {
      const currentList = prev[sensorName] || [];
      const updated = currentList.includes(param)
        ? currentList.filter(p => p !== param)
        : [...currentList, param];
      return { ...prev, [sensorName]: updated };
    });
  };

  // Compute totals
  const totalActiveSensors = Object.keys(activeSensorMap).filter(k => activeSensorMap[k]).length;
  const totalActiveParams = Object.keys(activeSensorMap)
    .filter(k => activeSensorMap[k])
    .reduce((acc, k) => acc + (activeParamsMap[k]?.length || 0), 0);

  const handleSave = () => {
    const mappedList = availableSensors
      .filter(s => activeSensorMap[s.sensorName])
      .map((s, idx) => ({
        id: s.id || `SN-ADM-${idx + 1}`,
        name: s.sensorName,
        tagColor: (idx % 3 === 0 ? 'teal' : idx % 3 === 1 ? 'amber' : 'purple') as 'teal' | 'amber' | 'purple',
        parameters: activeParamsMap[s.sensorName] || s.parameters || ['Real-time Metric']
      }));

    const newMapping: ToolMappingItem = {
      id: existingMapping?.id || `TM-${Date.now()}`,
      identifier: existingMapping?.identifier || `TL-ADM-${Math.floor(1000 + Math.random() * 9000)}`,
      toolName: toolName.trim() || 'Custom Telematics Suite',
      industryType: industryType,
      mappedSensors: mappedList,
      activeParametersCount: totalActiveParams,
      protocol: '',
      updatedAt: 'Just now'
    };

    onSave(newMapping);
    onClose();
  };

  return (
    <div 
      id="mappingModal"
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-in fade-in duration-150" 
      data-purpose="tool-sensor-mapping-modal"
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150">
        
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/30">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-sky-100 dark:bg-sky-950/60 text-sky-600 dark:text-sky-400 flex items-center justify-center">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-base text-slate-900 dark:text-white">
                {existingMapping ? 'Edit Tool Mapping Profile' : 'Create Tool Mapping from Admin Sensors'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Select from Master Admin Sensors to assemble a tool configuration profile
              </p>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 transition-colors cursor-pointer rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs">
          
          {/* Admin Sync Notice */}
          <div className="p-3 bg-sky-50 dark:bg-sky-950/40 rounded-xl border border-sky-200 dark:border-sky-800/60 flex items-center justify-between text-xs text-sky-800 dark:text-sky-300">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              <span>Catalog Source: <strong>{availableSensors.length} Admin Sensors Available</strong></span>
            </div>
            <span className="text-[11px] font-semibold text-sky-700 dark:text-sky-300 uppercase tracking-wider">Master Data</span>
          </div>

          {/* Profile Name & Industry */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Tool Profile Name <span className="text-red-500">*</span>
              </label>
              <input 
                type="text" 
                value={toolName}
                onChange={(e) => setToolName(e.target.value)}
                placeholder="e.g. Crusher Rig Pro Telematics" 
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Industrial Domain
              </label>
              <input 
                type="text" 
                value={industryType}
                onChange={(e) => setIndustryType(e.target.value)}
                placeholder="e.g. Heavy Construction & Mining" 
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-100 text-xs focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
              />
            </div>
          </div>

          {/* Sensors from Admin */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                Select Admin Sensors & Parameter Channels
              </label>
              <span className="text-xs font-semibold text-sky-600 dark:text-sky-400">
                {totalActiveSensors} Sensors • {totalActiveParams} Parameters Active
              </span>
            </div>

            <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
              {availableSensors.map((sensor) => {
                const isSensorActive = !!activeSensorMap[sensor.sensorName];
                const activeParams = activeParamsMap[sensor.sensorName] || [];
                const sensorParams = sensor.parameters && sensor.parameters.length > 0 
                  ? sensor.parameters 
                  : ['Differential Pressure', 'Telemetry Metric', 'Temperature Channel'];

                return (
                  <div 
                    key={sensor.id}
                    className={`p-3.5 rounded-xl border transition-all ${
                      isSensorActive
                        ? 'border-sky-300 dark:border-sky-700 bg-sky-50/40 dark:bg-sky-950/20'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-800/40 opacity-75'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <button
                        type="button"
                        onClick={() => toggleSensor(sensor.sensorName, sensorParams)}
                        className="flex items-center gap-2.5 text-left cursor-pointer"
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                          isSensorActive
                            ? 'bg-[#0B7285] border-[#0B7285] text-white'
                            : 'border-slate-300 dark:border-slate-600'
                        }`}>
                          {isSensorActive && <Check className="w-3 h-3" />}
                        </div>
                        <div>
                          <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">
                            {sensor.sensorName}
                          </span>
                          <span className="text-xs text-slate-400 ml-2">
                            ({sensor.category || sensor.industryType || 'Uncategorized'})
                          </span>
                        </div>
                      </button>

                      <span className="text-xs font-mono bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400">
                        {isSensorActive ? `${activeParams.length} Active` : 'Excluded'}
                      </span>
                    </div>

                    {isSensorActive && (
                      <div className="pl-6 pt-2 border-t border-slate-200/60 dark:border-slate-700/60 flex flex-wrap gap-2">
                        {sensorParams.map((param, pIdx) => {
                          const isParamActive = activeParams.includes(param);
                          return (
                            <button
                              key={pIdx}
                              type="button"
                              onClick={() => toggleParam(sensor.sensorName, param)}
                              className={`px-2.5 py-1 text-xs rounded-md border transition-colors cursor-pointer flex items-center gap-1.5 ${
                                isParamActive
                                  ? 'bg-[#0B7285] text-white border-[#0B7285]'
                                  : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              {isParamActive && <Check className="w-3 h-3" />}
                              <span>{param}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </div>

        {/* Modal Footer */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Profile saves into master Admin Tool Mappings
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="px-5 py-2 bg-[#0B7285] text-white hover:bg-[#095C6B] text-xs font-semibold rounded-lg shadow-xs transition-colors cursor-pointer"
            >
              Save Tool Mapping
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
