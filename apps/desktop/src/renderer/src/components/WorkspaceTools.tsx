import { useState } from 'react';
import {
  BarChart3,
  Bot,
  ChartPie,
  Database,
  Download,
  ListTodo,
  DatabaseZap,
  Trash2,
  X,
} from 'lucide-react';
import { Modal } from './Dialog';
import { FloatingToolsBar, type FloatingToolItem } from './FloatingToolsBar';
import { RetainedTabs } from './RetainedTabs';
import { ExportTool } from '../views/ExportView';
import { AgentLabView } from '../views/AgentLabView';
import { DbExplorer } from '../views/cache/DbExplorer';
import { ResourceAnalyticsDialog } from '../views/cache/ResourceAnalyticsDialog';
import { ResourceCleanupDialog } from '../views/cache/ResourceCleanupDialog';
import { trpc } from '../trpc/client';
import { useCurrentContentSelection } from '../state/contentSelection';
import '../styles/workspace-tools.css';

type Tool = 'export' | 'tasks' | 'assistant' | 'database' | 'storage' | 'cleanup';
const TITLES: Record<Tool, string> = {
  export: '导出',
  tasks: '任务',
  assistant: 'WeQ 助手',
  database: '数据库管理',
  storage: '存储占用',
  cleanup: '清理缓存',
};

export function WorkspaceTools({
  onOpenAnalysis,
  onOpenDbRepair,
}: {
  onOpenAnalysis: () => void;
  onOpenDbRepair: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('export');
  const selection = useCurrentContentSelection();
  const tasks = trpc.account.listExportTasks.useQuery(undefined, { refetchInterval: 5000 });
  const config = trpc.account.getAccountConfig.useQuery();
  const running =
    tasks.data?.filter((task) => task.status === 'running' || task.save?.status === 'saving')
      .length ?? 0;
  const separate = tool === 'storage' || tool === 'cleanup';
  const close = () => setOpen(false);
  const select = (next: Tool) => {
    setTool(next);
    setOpen(true);
  };
  const leave = (action: () => void) => {
    close();
    action();
  };
  const items: FloatingToolItem[] = [
    { id: 'export', label: '导出', icon: <Download size={20} />, action: () => select('export') },
    { id: 'tasks', label: '任务', icon: <ListTodo size={20} />, action: () => select('tasks') },
    {
      id: 'analysis',
      label: '分析与报告',
      icon: <BarChart3 size={20} />,
      action: () => leave(onOpenAnalysis),
    },
    {
      id: 'assistant',
      label: 'WeQ 助手',
      icon: <Bot size={20} />,
      action: () => select('assistant'),
    },
    {
      id: 'database',
      label: '数据库管理',
      icon: <Database size={20} />,
      action: () => select('database'),
    },
    ...(config.data && !config.data.static
      ? [
          {
            id: 'storage',
            label: '存储占用',
            icon: <ChartPie size={20} />,
            action: () => select('storage'),
          },
          {
            id: 'cleanup',
            label: '清理缓存',
            icon: <Trash2 size={20} />,
            action: () => select('cleanup'),
          },
        ]
      : []),
    {
      id: 'db-repair',
      label: '数据库修复',
      icon: <DatabaseZap size={20} />,
      action: () => leave(onOpenDbRepair),
    },
  ];
  return (
    <>
      <FloatingToolsBar items={items} running={running} />
      <Modal
        open={open && !separate}
        onClose={close}
        width={1000}
        className="weq-tools-modal"
        labelledBy="weq-tools-title"
      >
        <header className="weq-tools-header">
          <h2 id="weq-tools-title">{TITLES[tool]}</h2>
          <button type="button" onClick={close} title="关闭工具" aria-label="关闭工具">
            <X size={18} />
          </button>
        </header>
        <RetainedTabs activeKey={open && !separate ? tool : 'closed'}>
          {open && !separate ? (
            tool === 'export' ? (
              <ExportTool initialSelection={selection ?? undefined} />
            ) : tool === 'tasks' ? (
              <ExportTool surface="tasks" />
            ) : tool === 'assistant' ? (
              <AgentLabView mode="assistant" />
            ) : tool === 'database' ? (
              <DbExplorer />
            ) : null
          ) : null}
        </RetainedTabs>
      </Modal>
      {open && tool === 'storage' ? <ResourceAnalyticsDialog open onClose={close} /> : null}
      {open && tool === 'cleanup' ? <ResourceCleanupDialog open onClose={close} /> : null}
    </>
  );
}
