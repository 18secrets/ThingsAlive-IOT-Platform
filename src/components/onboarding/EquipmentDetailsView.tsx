import React from 'react';
import { Truck, MapPin, AlertCircle, Activity } from 'lucide-react';

interface EquipmentDetail {
  name: string;
  category: string;
  description: string;
  onboardStatus: 'Onboarded' | 'Pending';
  status: 'Online' | 'Offline';
  maintenancePlant: string;
  cclNumber: string;
  manufacturer: string;
  modelNumber: string;
  licensePlate: string;
  engine: string;
  power: number;
  dateAdded: string;
  lastUpdated: string;
  errorCodesCount: number;
  liveParams: {
    engineRunningStatus: 'ON' | 'OFF';
    fuelConsumptionL: number;
  };
}

const SAMPLE_EQUIPMENT: EquipmentDetail = {
  name: 'DG Set - Cummins 500 kVA',
  category: 'Dumpers',
  description: 'Cummins 500 kVA Diesel Generator for Plant Backup Power',
  onboardStatus: 'Onboarded',
  status: 'Online',
  maintenancePlant: 'NA',
  cclNumber: 'CCL-2026-45892',
  manufacturer: 'Cummins India Ltd.',
  modelNumber: 'C500D5',
  licensePlate: 'KA01AB4589',
  engine: 'Diesel',
  power: 597.0,
  dateAdded: '05/08/2026',
  lastUpdated: '09/09/2026, 04:30:00 pm',
  errorCodesCount: 0,
  liveParams: {
    engineRunningStatus: 'ON',
    fuelConsumptionL: 135.6,
  },
};

interface EquipmentDetailsViewProps {
  equipment?: EquipmentDetail;
}

export const EquipmentDetailsView: React.FC<EquipmentDetailsViewProps> = ({
  equipment = SAMPLE_EQUIPMENT,
}) => {
  const eq = equipment;

  return (
    <div id="equipment-details-view" className="space-y-5">

      {/* Top Card: Photo + Info Grid + Map */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs p-5 flex flex-col lg:flex-row gap-6">

        {/* Equipment Photo */}
        <div className="w-full lg:w-64 h-56 lg:h-auto shrink-0 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg flex items-center justify-center">
          <Truck className="w-20 h-20 text-slate-300 dark:text-slate-600" strokeWidth={1.5} />
        </div>

        {/* Info Grid */}
        <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-5 text-sm">
          <div>
            <div className="text-slate-400 dark:text-slate-500">Equipment :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{eq.name}</div>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">Category :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{eq.category}</div>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">Description :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5 leading-snug">{eq.description}</div>
          </div>

          <div>
            <div className="text-slate-400 dark:text-slate-500">Onboard Status :</div>
            <span className="inline-block mt-1 px-3 py-1 rounded-md bg-emerald-500 text-white text-xs font-semibold">
              {eq.onboardStatus}
            </span>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">Status :</div>
            <span className="inline-block mt-1 px-3 py-1 rounded-md bg-emerald-500 text-white text-xs font-semibold">
              {eq.status}
            </span>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">Maintenance Plant :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{eq.maintenancePlant}</div>
          </div>

          <div>
            <div className="text-slate-400 dark:text-slate-500">CCL Number :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5 font-mono">{eq.cclNumber}</div>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">Manufacturer :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{eq.manufacturer}</div>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">Model Number :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5 font-mono">{eq.modelNumber}</div>
          </div>

          <div>
            <div className="text-slate-400 dark:text-slate-500">License Plate :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5 font-mono">{eq.licensePlate}</div>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">Engine :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{eq.engine}</div>
          </div>
          <div>
            <div className="text-slate-400 dark:text-slate-500">Power :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{eq.power.toFixed(2)}</div>
          </div>

          <div>
            <div className="text-slate-400 dark:text-slate-500">Date Added :</div>
            <div className="font-semibold text-slate-800 dark:text-slate-100 mt-0.5">{eq.dateAdded}</div>
          </div>
        </div>

        {/* Location Map (decorative placeholder) */}
        <div className="w-full lg:w-72 h-56 lg:h-auto shrink-0 relative rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-[#EAE6DC]">
          {/* faux road network */}
          <div className="absolute inset-0">
            <div className="absolute left-[10%] top-0 bottom-0 w-[3px] bg-white/70 -rotate-6" />
            <div className="absolute left-[55%] top-0 bottom-0 w-[5px] bg-white/80 rotate-3" />
            <div className="absolute top-[30%] left-0 right-0 h-[3px] bg-white/70 rotate-2" />
            <div className="absolute top-[68%] left-0 right-0 h-[4px] bg-white/70 -rotate-3" />
            <div className="absolute left-[80%] top-0 bottom-0 w-[2px] bg-white/50 rotate-12" />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <MapPin className="w-9 h-9 text-rose-600 fill-rose-600/20 drop-shadow" strokeWidth={2} />
          </div>
          <div className="absolute bottom-1.5 left-2 text-[11px] font-medium text-slate-600/70">Google</div>
          <div className="absolute bottom-1.5 right-2 text-[10px] text-slate-600/60">Map Data &nbsp; Terms</div>
        </div>
      </div>

      {/* Live Parameters Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
        <span className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-rose-500 text-white text-sm font-semibold shrink-0 w-fit">
          <Activity className="w-3.5 h-3.5" />
          Live Parameters
        </span>
        <span className="flex-1 text-center text-sm text-slate-500 dark:text-slate-400">
          Last Updated: {eq.lastUpdated}
        </span>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-sm font-semibold text-rose-600 dark:text-rose-400">
            Error Codes : {eq.errorCodesCount}
          </span>
          <button className="px-4 py-1.5 bg-sky-600 hover:bg-sky-700 text-white rounded-lg text-sm font-medium shadow-xs transition-colors cursor-pointer">
            Start Diagnostic
          </button>
        </div>
      </div>

      {/* Metric Tiles + Error Panel */}
      <div className="flex flex-col lg:flex-row gap-6">
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs py-6 px-4 text-center">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Engine Running Status
            </div>
            <div className="text-2xl font-bold text-indigo-900 dark:text-indigo-300 mt-3">
              {eq.liveParams.engineRunningStatus}
            </div>
          </div>
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs py-6 px-4 text-center">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Fuel Consumption L
            </div>
            <div className="text-2xl font-bold text-indigo-900 dark:text-indigo-300 mt-3">
              {eq.liveParams.fuelConsumptionL}
            </div>
          </div>
        </div>

        <div className="w-full lg:w-72 shrink-0 flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400 pt-1">
          {eq.errorCodesCount === 0 && (
            <>
              <AlertCircle className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0 mt-0.5" />
              <span>No active error codes found</span>
            </>
          )}
        </div>
      </div>

    </div>
  );
};
