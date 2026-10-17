import { useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  BarChart3,
  Bot,
  ChartPie,
  Database,
  Download,
  ListTodo,
  Settings,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { Modal } from './Dialog';
import { RetainedTabs } from './RetainedTabs';
import { ExportTool } from '../views/ExportView';
import { AgentLabView } from '../views/AgentLabView';
import { DbExplorer } from '../views/cache/DbExplorer';
import { ResourceAnalyticsDialog } from '../views/cache/ResourceAnalyticsDialog';
import { ResourceCleanupDialog } from '../views/cache/ResourceCleanupDialog';
import { trpc } from '../trpc/client';
import { useCurrentContentSelection } from '../state/contentSelection';
import '../styles/workspace-tools.css';

type Tool = 'menu' | 'export' | 'tasks' | 'assistant' | 'database' | 'storage' | 'cleanup';
const TITLES: Record<Tool, string> = {
  menu: '工具',
  export: '导出',
  tasks: '任务',
  assistant: 'WeQ 助手',
  database: '数据库管理',
  storage: '存储占用',
  cleanup: '清理缓存',
};

export function WorkspaceTools({
  onOpenAnalysis,
  onOpenMaintenance,
  onOpenSettings,
}: {
  onOpenAnalysis: () => void;
  onOpenMaintenance: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('menu');
  const selection = useCurrentContentSelection();
  const tasks = trpc.account.listExportTasks.useQuery(undefined, { refetchInterval: 5000 });
  const config = trpc.account.getAccountConfig.useQuery();
  const running = tasks.data?.filter((task) => task.status === 'running').length ?? 0;
  const separate = tool === 'storage' || tool === 'cleanup';
  const close = () => setOpen(false);
  const leave = (action: () => void) => {
    close();
    action();
  };
  const items: { id: string; label: string; icon: ReactNode; action: () => void }[] = [
    { id: 'export', label: '导出', icon: <Download size={20} />, action: () => setTool('export') },
    { id: 'tasks', label: '任务', icon: <ListTodo size={20} />, action: () => setTool('tasks') },
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
      action: () => setTool('assistant'),
    },
    {
      id: 'database',
      label: '数据库管理',
      icon: <Database size={20} />,
      action: () => setTool('database'),
    },
    ...(!config.data?.static
      ? [
          {
            id: 'storage',
            label: '存储占用',
            icon: <ChartPie size={20} />,
            action: () => setTool('storage'),
          },
          {
            id: 'cleanup',
            label: '清理缓存',
            icon: <Trash2 size={20} />,
            action: () => setTool('cleanup'),
          },
        ]
      : []),
    {
      id: 'maintenance',
      label: '维护工具',
      icon: <Wrench size={20} />,
      action: () => leave(onOpenMaintenance),
    },
    {
      id: 'settings',
      label: '默认配置',
      icon: <Settings size={20} />,
      action: () => leave(onOpenSettings),
    },
  ];
  return (
    <>
      <button
        type="button"
        className="weq-tools-trigger"
        aria-label={running ? `工具，${running} 个任务运行中` : '工具'}
        title="工具"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setTool('menu');
          setOpen(true);
        }}
      >
        <Wrench size={22} />
        {running > 0 ? <span className="weq-tools-running">{running}</span> : null}
      </button>
      <Modal
        open={open && !separate}
        onClose={close}
        width={1000}
        className="weq-tools-modal"
        labelledBy="weq-tools-title"
      >
        <header className="weq-tools-header">
          {tool !== 'menu' ? (
            <button
              type="button"
              onClick={() => setTool('menu')}
              title="返回工具"
              aria-label="返回工具"
            >
              <ArrowLeft size={18} />
            </button>
          ) : null}
          <h2 id="weq-tools-title">{TITLES[tool]}</h2>
          <button type="button" onClick={close} title="关闭工具" aria-label="关闭工具">
            <X size={18} />
          </button>
        </header>
        <RetainedTabs activeKey={open && !separate ? tool : 'closed'}>
          {open && !separate ? (
            tool === 'menu' ? (
              <nav className="weq-tools-menu" aria-label="工具">
                {items.map((item) => (
                  <button key={item.id} type="button" onClick={item.action}>
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
              </nav>
            ) : tool === 'export' ? (
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
