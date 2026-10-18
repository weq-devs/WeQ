import { useEffect, useState } from 'react';
import type { GeneratedSearchHit } from './search/types';
import {
  BarChart3,
  Bot,
  CloudDownload,
  Download,
  FileStack,
  ListTodo,
  Settings,
  X,
} from 'lucide-react';
import { Modal } from './Dialog';
import { FloatingToolsBar, type FloatingToolItem } from './FloatingToolsBar';
import { RetainedTabs } from './RetainedTabs';
import { ExportTool } from '../views/ExportView';
import { AgentLabView } from '../views/AgentLabView';
import { trpc } from '../trpc/client';
import { useCurrentContentSelection } from '../state/contentSelection';
import '../styles/workspace-tools.css';
import { RoamingBackfillPanel } from './RoamingBackfillPanel';
import { DaemonSection } from './settings/DaemonSection';

type Tool = 'export' | 'tasks' | 'assistant' | 'backfill';
const TITLES: Record<Tool, string> = {
  export: '导出',
  tasks: '任务',
  assistant: 'WeQ 助手',
  backfill: '消息补全',
};

export function WorkspaceTools({
  onOpenAnalysis,
  onOpenComposition,
  assistantSearchTarget,
  hidden = false,
}: {
  onOpenAnalysis: () => void;
  onOpenComposition?: () => void;
  assistantSearchTarget?: GeneratedSearchHit | null;
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('export');
  const [assistantSettings, setAssistantSettings] = useState(false);
  useEffect(() => {
    if (assistantSearchTarget) {
      setTool('assistant');
      setAssistantSettings(false);
      setOpen(true);
    }
  }, [assistantSearchTarget]);
  const selection = useCurrentContentSelection();
  const tasks = trpc.account.listExportTasks.useQuery(undefined, { refetchInterval: 5000 });
  const running =
    tasks.data?.filter((task) => task.status === 'running' || task.save?.status === 'saving')
      .length ?? 0;
  const close = () => setOpen(false);
  const select = (next: Tool) => {
    setTool(next);
    setAssistantSettings(false);
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
      id: 'backfill',
      label: '消息补全',
      icon: <CloudDownload size={20} />,
      action: () => select('backfill'),
    },
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
  ];
  if (onOpenComposition)
    items.push({
      id: 'composition',
      label: '合成聊天记录',
      icon: <FileStack size={20} />,
      action: () => leave(onOpenComposition),
    });
  return (
    <>
      <FloatingToolsBar
        items={items}
        running={running}
        hidden={hidden}
        expandKey={selection ? `${selection.owner.kind}:${selection.owner.container}` : undefined}
      />
      <Modal
        presentation="modal"
        open={open}
        onClose={close}
        width={tool === 'tasks' ? 560 : 1000}
        className="weq-tools-modal"
        labelledBy="weq-tools-title"
      >
        <header className="weq-tools-header">
          <h2 id="weq-tools-title">{TITLES[tool]}</h2>
          {tool === 'assistant' && (
            <button
              type="button"
              aria-label="QQ 公众号推送设置"
              title="QQ 公众号推送设置"
              aria-pressed={assistantSettings}
              onClick={() => setAssistantSettings((value) => !value)}
            >
              <Settings size={18} />
            </button>
          )}
          <button type="button" onClick={close} title="关闭工具" aria-label="关闭工具">
            <X size={18} />
          </button>
        </header>
        <RetainedTabs activeKey={open ? tool : 'closed'}>
          {open ? (
            tool === 'export' ? (
              <ExportTool initialSelection={selection ?? undefined} />
            ) : tool === 'tasks' ? (
              <ExportTool surface="tasks" />
            ) : tool === 'assistant' ? (
              <>
                <div hidden={assistantSettings} style={{ height: '100%' }}>
                  <AgentLabView mode="assistant" searchTarget={assistantSearchTarget} />
                </div>
                {assistantSettings && (
                  <div className="weq-assistant-service-settings">
                    <DaemonSection panel="assistant" />
                  </div>
                )}
              </>
            ) : tool === 'backfill' ? (
              <RoamingBackfillPanel />
            ) : null
          ) : null}
        </RetainedTabs>
      </Modal>
    </>
  );
}
