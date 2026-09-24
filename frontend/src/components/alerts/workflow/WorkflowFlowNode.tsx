import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { describeWorkflowNode, type WorkflowNode } from './workflowGraph';

const handleClass =
  '!w-2.5 !h-2.5 !border-2 !border-white dark:!border-slate-900 !bg-slate-400 dark:!bg-slate-500';

export const WorkflowFlowNode: React.FC<NodeProps<WorkflowNode>> = ({ data, selected }) => {
  const Icon = data.icon;
  const { title, subtitle } = describeWorkflowNode(data);

  return (
    <div
      className={`bg-white dark:bg-slate-800 border rounded-lg shadow-xs px-3 py-2 flex items-center gap-2.5 w-[168px] h-[56px] transition-colors ${
        selected ? 'border-sky-400 dark:border-sky-600 ring-2 ring-sky-200 dark:ring-sky-900' : 'border-slate-200 dark:border-slate-700'
      }`}
    >
      {data.kind !== 'trigger' && <Handle type="target" position={Position.Left} className={handleClass} />}
      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${data.iconBg}`}>
        <Icon className={`w-3.5 h-3.5 ${data.iconColor}`} />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">{title}</div>
        {subtitle && <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{subtitle}</div>}
      </div>
      <Handle type="source" position={Position.Right} className={handleClass} />
    </div>
  );
};
