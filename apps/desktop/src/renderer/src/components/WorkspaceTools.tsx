import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getCloneTasks, subscribeCloneTasks } from '../views/agentlab/cloneTaskStore';
import type { GeneratedSearchHit } from './search/types';
import { BarChart3, Bot, Download, FileStack, ListTodo, Settings, X } from 'lucide-react';
import { Modal } from './Dialog';
import { FloatingToolsBar, type FloatingToolItem } from './FloatingToolsBar';
import { RetainedTabs } from './RetainedTabs';
import { ExportTool } from '../views/ExportView';
import { AgentLabView } from '../views/AgentLabView';
import { trpc } from '../trpc/client';
import {
  useContentExportRequest,
  useContentAnalysisRequest,
  useCurrentContentSelection,
} from '../state/contentSelection';
import '../styles/workspace-tools.css';
import { RoamingBackfillPanel } from './RoamingBackfillPanel';
import { DaemonSection } from './settings/DaemonSection';
import { useViewState } from '../state/view';
import { createToolDraft, type ToolDraft } from '../../../shared/content_selection';
import { AnalysisTool } from '../views/analysis/AnalysisTool';
import type {
  AnalysisReportRequest,
  AnalysisTarget,
  AnalysisToolRequest,
} from '../views/analysis/model';
import type { Conversation } from '../im-template/template/types';
import type { RoamingTarget } from '@weq/service';
import {
  conversationAnalysisTarget,
  conversationExportSelection,
} from '../lib/conversationActions';

type Tool = 'export' | 'tasks' | 'assistant' | 'backfill' | 'analysis';
const TITLES: Record<Tool, string> = {
  export: '导出',
  tasks: '任务',
  assistant: 'WeQ 助手',
  backfill: '拉取漫游消息',
  analysis: '分析与报告',
};

export function WorkspaceTools({
  onOpenAnalysis,
  onOpenComposition,
  assistantSearchTarget,
  hidden = false,
  currentConversation,
  analysisRequest,
  roamingRequest,
  onOpenClone,
}: {
  onOpenAnalysis: (report: AnalysisReportRequest) => void;
  onOpenComposition?: () => void;
  assistantSearchTarget?: GeneratedSearchHit | null;
  hidden?: boolean;
  currentConversation?: Conversation | null;
  analysisRequest?: AnalysisToolRequest | null;
  roamingRequest?: { targets: RoamingTarget[]; revision: number } | null;
  onOpenClone?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<Tool>('export');
  const [assistantSettings, setAssistantSettings] = useState(false);
  const [analysisTarget, setAnalysisTarget] = useState<AnalysisTarget | undefined>();
  const [analysisMessageIds, setAnalysisMessageIds] = useState<string[] | undefined>();
  const [analysisFixedTarget, setAnalysisFixedTarget] = useState(false);
  const [exportFixedScope, setExportFixedScope] = useState(false);
  const [exportListRevision, setExportListRevision] = useState(0);
  const [roamingTargets, setRoamingTargets] = useState<RoamingTarget[]>([]);
  const [analysisSeed, setAnalysisSeed] = useState(0);
  const [roamingSeed, setRoamingSeed] = useState(0);
  const [taskAnchor, setTaskAnchor] = useState<HTMLElement | null>(null);
  const accountKey = useViewState((state) => state.openedUin);
  const [exportDraft, setExportDraft] = useState<{ key: string; draft: ToolDraft } | null>(null);
  const exportRequest = useContentExportRequest();
  const handledExportRequest = useRef<typeof exportRequest>(null);
  const handledAnalysisRequest = useRef<typeof analysisRequest>(null);
  const contentAnalysisRequest = useContentAnalysisRequest();
  const handledContentAnalysis = useRef<typeof contentAnalysisRequest>(null);
  useEffect(() => {
    if (
      !accountKey ||
      !contentAnalysisRequest ||
      handledContentAnalysis.current === contentAnalysisRequest
    )
      return;
    handledContentAnalysis.current = contentAnalysisRequest;
    setAnalysisFixedTarget(true);
    setAnalysisTarget({ ...contentAnalysisRequest.target });
    setAnalysisMessageIds(
      contentAnalysisRequest.messageIds ? [...contentAnalysisRequest.messageIds] : undefined,
    );
    setAnalysisSeed((previous) => previous + 1);
    setTool('analysis');
    setOpen(true);
  }, [accountKey, contentAnalysisRequest]);
  const handledRoamingRequest = useRef<typeof roamingRequest>(null);
  useEffect(() => {
    if (!accountKey || !analysisRequest || handledAnalysisRequest.current === analysisRequest)
      return;
    handledAnalysisRequest.current = analysisRequest;
    setAnalysisFixedTarget(true);
    setAnalysisTarget({ ...analysisRequest.target });
    setAnalysisMessageIds(undefined);
    setAnalysisSeed((previous) => previous + 1);
    setTool('analysis');
    setAssistantSettings(false);
    setOpen(true);
  }, [accountKey, analysisRequest]);
  useEffect(() => {
    if (!accountKey || !roamingRequest || handledRoamingRequest.current === roamingRequest) return;
    handledRoamingRequest.current = roamingRequest;
    setRoamingTargets(roamingRequest.targets.map((target) => ({ ...target })));
    setRoamingSeed((previous) => previous + 1);
    setTool('backfill');
    setAssistantSettings(false);
    setOpen(true);
  }, [accountKey, roamingRequest]);
  useEffect(() => {
    if (!accountKey || !exportRequest || handledExportRequest.current === exportRequest) return;
    handledExportRequest.current = exportRequest;
    setExportFixedScope(true);
    setExportDraft({
      key: JSON.stringify([accountKey, exportRequest.selection]),
      draft: createToolDraft(accountKey, exportRequest.selection),
    });
    setTool('export');
    setAssistantSettings(false);
    setOpen(true);
  }, [accountKey, exportRequest]);
  useEffect(() => {
    if (assistantSearchTarget) {
      setTool('assistant');
      setAssistantSettings(false);
      setOpen(true);
    }
  }, [assistantSearchTarget]);
  const selection = useCurrentContentSelection();
  const tasks = trpc.account.listExportTasks.useQuery(undefined, { refetchInterval: 5000 });
  const cloneTasks = useSyncExternalStore(subscribeCloneTasks, getCloneTasks);
  const running =
    (tasks.data?.filter((task) => task.status === 'running' || task.save?.status === 'saving')
      .length ?? 0) +
    cloneTasks.filter((task) => task.accountId === accountKey && task.status === 'running').length;
  const close = () => setOpen(false);
  const select = (next: Tool, anchor?: HTMLElement) => {
    if (next === 'tasks') setTaskAnchor(anchor ?? null);
    const exportSelection = selection ?? conversationExportSelection(currentConversation);
    if (next === 'export') {
      setExportFixedScope(false);
      setExportListRevision((previous) => previous + 1);
      if (exportSelection && accountKey) {
        const key = JSON.stringify([accountKey, exportSelection]);
        setExportDraft((previous) =>
          previous?.key === key
            ? previous
            : { key, draft: createToolDraft(accountKey, exportSelection) },
        );
      } else setExportDraft(null);
    }
    if (next === 'analysis') {
      setAnalysisFixedTarget(false);
      setAnalysisTarget(conversationAnalysisTarget(currentConversation) ?? undefined);
      setAnalysisMessageIds(undefined);
      setAnalysisSeed((previous) => previous + 1);
    }
    setTool(next);
    setAssistantSettings(false);
    setOpen(true);
  };
  const leave = (action: () => void) => {
    close();
    action();
  };
  const fixedExportScope =
    exportFixedScope &&
    (exportDraft?.draft.selection.owner.kind === 'messages' ||
      (exportDraft?.draft.selection.owner.kind === 'conversations' &&
        exportDraft.draft.selection.scope.type === 'items' &&
        exportDraft.draft.selection.scope.ids.length > 0));
  const items: FloatingToolItem[] = [
    { id: 'export', label: '导出', icon: <Download size={20} />, action: () => select('export') },
    {
      id: 'tasks',
      label: '任务',
      icon: <ListTodo size={20} />,
      action: (anchor) => select('tasks', anchor),
    },
    {
      id: 'analysis',
      label: '分析与报告',
      icon: <BarChart3 size={20} />,
      action: () => select('analysis'),
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
      <FloatingToolsBar items={items} running={running} hidden={hidden} />
      <Modal
        presentation="modal"
        dismissOnOutside={false}
        open={open && tool !== 'tasks' && tool !== 'backfill'}
        onClose={close}
        width={1000}
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
        <RetainedTabs
          key={accountKey ?? 'no-account'}
          activeKey={open && tool !== 'tasks' && tool !== 'backfill' ? tool : 'closed'}
        >
          {open && tool !== 'tasks' && tool !== 'backfill' ? (
            tool === 'export' ? (
              <ExportTool
                key={JSON.stringify([
                  exportDraft?.draft.accountId === accountKey ? exportDraft.key : 'empty',
                  fixedExportScope,
                ])}
                initialSelection={
                  exportDraft?.draft.accountId === accountKey
                    ? exportDraft.draft.selection
                    : undefined
                }
                onClose={close}
                fixedScope={fixedExportScope}
                contentListRevision={fixedExportScope ? undefined : exportListRevision}
              />
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
            ) : tool === 'analysis' ? (
              <AnalysisTool
                key={JSON.stringify([accountKey, analysisSeed])}
                initialTarget={analysisTarget}
                fixedTarget={analysisFixedTarget}
                messageIds={analysisMessageIds}
                onGenerate={(report) => leave(() => onOpenAnalysis(report))}
              />
            ) : null
          ) : null}
        </RetainedTabs>
      </Modal>
      <Modal
        presentation="anchored"
        anchor={taskAnchor}
        open={open && tool === 'tasks'}
        onClose={close}
        width={560}
        className="weq-tools-modal"
        labelledBy="weq-task-pane-title"
      >
        <header className="weq-tools-header">
          <h2 id="weq-task-pane-title">任务</h2>
          <button type="button" onClick={close} title="关闭任务" aria-label="关闭任务">
            <X size={18} />
          </button>
        </header>
        <RetainedTabs
          key={accountKey ?? 'no-account'}
          activeKey={open && tool === 'tasks' ? 'tasks' : 'closed'}
        >
          {open && tool === 'tasks' ? (
            <ExportTool
              surface="tasks"
              onOpenClone={(id) => {
                close();
                onOpenClone?.(id);
              }}
            />
          ) : null}
        </RetainedTabs>
      </Modal>
      <Modal
        presentation="floating"
        open={open && tool === 'backfill'}
        onClose={close}
        width={1000}
        className="weq-tools-modal"
        labelledBy="weq-backfill-title"
      >
        <header className="weq-tools-header" data-window-drag-handle>
          <h2 id="weq-backfill-title">拉取漫游消息</h2>
          <button type="button" onClick={close} title="关闭消息拉取" aria-label="关闭消息拉取">
            <X size={18} />
          </button>
        </header>
        <RetainedTabs
          key={accountKey ?? 'no-account'}
          activeKey={open && tool === 'backfill' ? 'backfill' : 'closed'}
        >
          {open && tool === 'backfill' ? (
            <RoamingBackfillPanel
              key={JSON.stringify([accountKey, roamingTargets, roamingSeed])}
              initialTargets={roamingTargets}
              targetMode="fixed"
            />
          ) : null}
        </RetainedTabs>
      </Modal>
    </>
  );
}
