import { useEffect, useState } from 'react';
import type { GeneratedSearchHit } from './search/types';
import { BarChart3, Bot, Download, ListTodo, X } from 'lucide-react';
import { Modal } from './Dialog';
import { FloatingToolsBar, type FloatingToolItem } from './FloatingToolsBar';
import { RetainedTabs } from './RetainedTabs';
import { ExportTool } from '../views/ExportView';
import { AgentLabView } from '../views/AgentLabView';
import { trpc } from '../trpc/client';
import { useCurrentContentSelection } from '../state/contentSelection';
import '../styles/workspace-tools.css';

type Tool = 'export' | 'tasks' | 'assistant';
const TITLES: Record<Tool, string> = {
  export: '导出',
  tasks: '任务',
  assistant: 'WeQ 助手',
};

export function WorkspaceTools({
  onOpenAnalysis,
  assistantSearchTarget,
}: {
  onOpenAnalysis: () => void;
  assistantSearchTarget?: GeneratedSearchHit | null;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('export');
  useEffect(() => {
    if (assistantSearchTarget) {
      setTool('assistant');
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
  ];
  return (
    <>
      <FloatingToolsBar items={items} running={running} />
      <Modal
        open={open}
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
        <RetainedTabs activeKey={open ? tool : 'closed'}>
          {open ? (
            tool === 'export' ? (
              <ExportTool initialSelection={selection ?? undefined} />
            ) : tool === 'tasks' ? (
              <ExportTool surface="tasks" />
            ) : tool === 'assistant' ? (
              <AgentLabView mode="assistant" searchTarget={assistantSearchTarget} />
            ) : null
          ) : null}
        </RetainedTabs>
      </Modal>
    </>
  );
}
