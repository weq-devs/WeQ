import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getCloneTasks, subscribeCloneTasks } from '../views/agentlab/cloneTaskStore';
import type { GeneratedSearchHit } from './search/types';
import type { ToolSearchRequest } from './search/appSearchCatalog';
import {
  BarChart3,
  Download,
  FileStack,
  FolderOpen,
  ListTodo,
  Settings,
  ShieldAlert,
  X,
  Bot as AssistantIcon,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import type { ExportAuthorizationIndicatorState } from '../views/export/authorization';
import { Modal } from './Dialog';
import { RetainedTabs, TabActivity } from './RetainedTabs';
import {
  ExportTool,
  ExportViewer,
  AnalysisTool,
  RoamingBackfillPanel,
  preloadWorkspace,
} from './lazyWorkspaces';
import { AssistantMenuWorkspace } from '../views/agentlab/AssistantMenuWorkspace';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { summarizeWorkspaceTasks } from '../lib/workspaceIndicators';
import { WorkspaceStatusDot } from './WorkspaceStatusDot';
import { trpc } from '../trpc/client';
import {
  useContentExportRequest,
  useContentAnalysisRequest,
  useCurrentContentSelection,
} from '../state/contentSelection';
import '../styles/workspace-tools.css';
import '../styles/workspace-menu.css';
import { AssistantSection } from './settings/AssistantSection';
import { useViewState } from '../state/view';
import { createToolDraft, type ToolDraft } from '../../../shared/content_selection';
import { initialExportMode } from '../views/export/exportScope';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import type {
  AnalysisReportRequest,
  AnalysisTarget,
  AnalysisToolRequest,
} from '../views/analysis/model';
import type { Conversation } from '../im-template/template/types';
import type { RoamingTarget } from '@weq/service';
import { conversationAnalysisTarget } from '../lib/conversationActions';
import type { ContentSelection } from '../../../shared/content_selection';
import type { ExportMode } from '../views/export/types';
import {
  analysisTargetForWorkspace,
  selectionForWorkspace,
  defaultSelectionForContext,
  exportEntryForWorkspace,
  type WorkspaceContext,
} from '../lib/toolTargets';

type Tool = 'export' | 'viewer' | 'backfill' | 'analysis';
const TITLES: Record<Tool, string> = {
  export: '导出',
  viewer: '导出查看器',
  backfill: '拉取漫游消息',
  analysis: '分析与报告',
};
const ACTION_LABELS: Record<string, string> = {
  analysis: '分析',
  export: '导出',
  viewer: '查看',
  composition: '合成',
};

export function WorkspaceTools({
  accountScope,
  footerControls,
  onOpenAnalysis,
  onOpenComposition,
  assistantSearchTarget,
  searchRequest,
  hidden = false,
  currentConversation,
  workspace,
  analysisRequest,
  roamingRequest,
  onOpenClone,
}: {
  accountScope: string;
  footerControls: ReactNode;
  onOpenAnalysis: (report: AnalysisReportRequest) => void;
  onOpenComposition?: () => void;
  assistantSearchTarget?: GeneratedSearchHit | null;
  searchRequest?: ToolSearchRequest | null;
  hidden?: boolean;
  currentConversation?: Conversation | null;
  /** 当前界面上下文：主按钮据此决定进入哪个工具、带哪份内容。 */
  workspace?: WorkspaceContext;
  analysisRequest?: AnalysisToolRequest | null;
  roamingRequest?: { targets: RoamingTarget[]; revision: number } | null;
  onOpenClone?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useWorkspaceMenu((state) => state.anchor);
  const closeMenu = useWorkspaceMenu((state) => state.close);
  const setTaskSummary = useWorkspaceMenu((state) => state.setTasks);
  const syncTasks = useWorkspaceMenu((state) => state.syncTasks);
  const finished = useWorkspaceMenu((state) => state.finished);
  const assistantActivity = useWorkspaceMenu((state) => state.assistant);
  const assistantUnread = useWorkspaceMenu((state) => state.assistantUnread);
  const [expanded, setExpanded] = useState(false);
  const lastAnchor = useRef<HTMLElement | null>(null);
  if (anchor) lastAnchor.current = anchor;
  const [panel, setPanel] = useState<'tasks' | 'assistant'>(() => {
    try {
      return window.localStorage.getItem(`weq:workspace-panel:${accountScope}`) === 'assistant'
        ? 'assistant'
        : 'tasks';
    } catch {
      return 'tasks';
    }
  });
  const [exportAuthorization, setExportAuthorization] =
    useState<ExportAuthorizationIndicatorState | null>(null);
  const [tool, setTool] = useState<Tool>('export');
  const [assistantSettings, setAssistantSettings] = useState(false);
  const [analysisTarget, setAnalysisTarget] = useState<AnalysisTarget | undefined>();
  const [analysisMessageIds, setAnalysisMessageIds] = useState<string[] | undefined>();
  const [analysisFixedTarget, setAnalysisFixedTarget] = useState(false);
  const [exportFixedScope, setExportFixedScope] = useState(false);
  const [exportMode, setExportMode] = useState<ExportMode | undefined>();
  const [exportBaseline, setExportBaseline] = useState<string>();
  const [exportListRevision, setExportListRevision] = useState(0);
  const [roamingTargets, setRoamingTargets] = useState<RoamingTarget[]>([]);
  const [analysisSeed, setAnalysisSeed] = useState(0);
  const [roamingSeed, setRoamingSeed] = useState(0);
  const accountKey = useViewState((state) => state.openedUin);
  const [exportDraft, setExportDraft] = useState<{ key: string; draft: ToolDraft } | null>(null);
  const exportRequest = useContentExportRequest();
  const handledExportRequest = useRef<typeof exportRequest>(null);
  /** 最近一次内容页显式导出请求的选区（关闭工具后再次打开仍沿用这份草稿）。 */
  const requestedSelection = useRef<ContentSelection | null>(null);
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
    closeMenu();
    setExpanded(false);
    setAnalysisFixedTarget(true);
    setAnalysisTarget({ ...contentAnalysisRequest.target });
    setAnalysisMessageIds(
      contentAnalysisRequest.messageIds ? [...contentAnalysisRequest.messageIds] : undefined,
    );
    setAnalysisSeed((previous) => previous + 1);
    setTool('analysis');
    setOpen(true);
  }, [accountKey, contentAnalysisRequest, closeMenu]);
  const handledRoamingRequest = useRef<typeof roamingRequest>(null);
  useEffect(() => {
    if (!accountKey || !analysisRequest || handledAnalysisRequest.current === analysisRequest)
      return;
    handledAnalysisRequest.current = analysisRequest;
    closeMenu();
    setExpanded(false);
    setAnalysisFixedTarget(true);
    setAnalysisTarget({ ...analysisRequest.target });
    setAnalysisMessageIds(undefined);
    setAnalysisSeed((previous) => previous + 1);
    setTool('analysis');
    setAssistantSettings(false);
    setOpen(true);
  }, [accountKey, analysisRequest, closeMenu]);
  useEffect(() => {
    if (!accountKey || !roamingRequest || handledRoamingRequest.current === roamingRequest) return;
    handledRoamingRequest.current = roamingRequest;
    closeMenu();
    setExpanded(false);
    setRoamingTargets(roamingRequest.targets.map((target) => ({ ...target })));
    setRoamingSeed((previous) => previous + 1);
    setTool('backfill');
    setAssistantSettings(false);
    setOpen(true);
  }, [accountKey, roamingRequest, closeMenu]);
  useEffect(() => {
    if (!accountKey || !exportRequest || handledExportRequest.current === exportRequest) return;
    handledExportRequest.current = exportRequest;
    closeMenu();
    setExpanded(false);
    // 记录这次显式请求的来源选择，供「关闭后再点主按钮」复用同一面板现场。
    requestedSelection.current = exportRequest.selection;
    setExportFixedScope(true);
    // 显式请求已经把内容定死了，面板里的种类列表没有意义，直接用请求自身的种类。
    setExportMode(initialExportMode(exportRequest.selection));
    setExportDraft({
      key: JSON.stringify([accountKey, exportRequest.selection]),
      draft: createToolDraft(accountKey, exportRequest.selection),
    });
    setTool('export');
    setAssistantSettings(false);
    setOpen(true);
  }, [accountKey, exportRequest, closeMenu]);
  useEffect(() => {
    if (assistantSearchTarget) {
      setOpen(false);
      setPanel('assistant');
      closeMenu();
      setExpanded(true);
      setAssistantSettings(false);
    }
  }, [assistantSearchTarget, closeMenu]);
  const selection = useCurrentContentSelection();
  const { enabled: readTasks } = useQQReadActivity(!hidden, { onlineOnly: false });
  const taskQueryOptions = {
    enabled: readTasks,
    refetchInterval: readTasks ? 5000 : (false as const),
  };
  const tasks = trpc.account.listExportTasks.useQuery(undefined, taskQueryOptions);
  const roamingTasks = trpc.account.roamingBackfill.list.useQuery(undefined, taskQueryOptions);
  const flashTasks = trpc.account.flashListDownloadTasks.useQuery(undefined, taskQueryOptions);
  const cloneTasks = useSyncExternalStore(subscribeCloneTasks, getCloneTasks);
  const taskDataReady =
    tasks.data !== undefined && roamingTasks.data !== undefined && flashTasks.data !== undefined;
  const {
    running,
    failed,
    items: taskItems,
  } = summarizeWorkspaceTasks({
    exports: tasks.data,
    clones: cloneTasks.filter((task) => task.accountId === accountKey),
    roaming: roamingTasks.data?.jobs,
    scanning: roamingTasks.data?.scanning,
    flash: flashTasks.data,
  });
  useEffect(() => {
    if (taskDataReady) syncTasks(accountScope, taskItems);
  }, [accountScope, taskItems, taskDataReady, syncTasks]);
  useEffect(
    () => () => {
      closeMenu();
      setTaskSummary(0, 0);
    },
    [closeMenu, setTaskSummary],
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(`weq:workspace-panel:${accountScope}`, panel);
    } catch {}
  }, [accountScope, panel]);
  const closeWorkspace = () => {
    closeMenu();
    setExpanded(false);
  };
  const close = () => setOpen(false);
  const ctx: WorkspaceContext = workspace ?? {
    view: 'messages',
    conversation: currentConversation ?? null,
  };
  const entry = exportEntryForWorkspace(ctx);

  /** 把选中的草稿交给导出面板。 */
  const openExport = (
    nextSelection: ContentSelection | null | undefined,
    options: { fixed?: boolean; mode?: ExportMode; baselineDirectory?: string } = {},
  ) => {
    closeWorkspace();
    setExportBaseline(options.baselineDirectory);
    const key = nextSelection && accountKey ? JSON.stringify([accountKey, nextSelection]) : null;
    // 同一份选择重新打开工具时保留面板现场（输入过的草稿、已选格式都还在）。
    // 固定范围与完整选择界面切换时重建，避免查看器的增量入口沿用旧的列表模式。
    // 种类切换由面板自己负责，不算重建理由。
    const sameDraft = Boolean(key && exportDraft?.key === key);
    const modeSwitch = options.fixed !== undefined && options.fixed !== fixedExportScope;
    if (sameDraft && !modeSwitch) {
      setExportListRevision((previous) => previous + 1);
      setTool('export');
      setAssistantSettings(false);
      setOpen(true);
      return;
    }
    setExportFixedScope(options.fixed === true);
    setExportMode(options.mode);
    setExportListRevision((previous) => previous + 1);
    setExportDraft(
      key && nextSelection && accountKey
        ? { key, draft: createToolDraft(accountKey, nextSelection) }
        : null,
    );
    setTool('export');
    setAssistantSettings(false);
    setOpen(true);
  };

  /** 主按钮：按当前界面直接进入对应工具。 */
  const select = (next: Tool, requestedMode?: ExportMode) => {
    closeWorkspace();
    if (next === 'export') {
      if (requestedMode) {
        requestedSelection.current = null;
        openExport(null, { mode: requestedMode, fixed: false });
        return;
      }
      // 主按钮＝按当前界面直接进入。注意不能把 `entry.selection`（带 selected 的对象）
      // 直接放进 React 依赖里：每次渲染都是新引用，会触发导出面板反复重建。
      // 优先级：页面内当前多选 > 内容页显式请求过的内容 > 当前界面位置。
      // 支持与否的界面都允许打开：没有内容时面板里自己选。
      const activeSelection = workspace ? selectionForWorkspace(ctx, selection) : selection;
      const explicit =
        activeSelection ?? requestedSelection.current ?? defaultSelectionForContext(ctx);
      openExport(explicit, {
        mode: explicit ? initialExportMode(explicit) : entry.mode,
        fixed: false,
      });
      return;
    }
    if (next === 'analysis') {
      // 主按钮：能确定当前对象（群聊 / 好友私聊）就直接固定它；没有就打开完整选择器，
      // 由使用者在面板里挑（例如从悬浮工具进来、当前在别的页面）。
      const directTarget =
        conversationAnalysisTarget(currentConversation) ?? analysisTargetForWorkspace(ctx);
      setAnalysisFixedTarget(Boolean(directTarget));
      setAnalysisTarget(directTarget ?? undefined);
      setAnalysisMessageIds(undefined);
      setAnalysisSeed((previous) => previous + 1);
    }
    if (next === 'backfill') {
      setRoamingTargets([]);
      setRoamingSeed((previous) => previous + 1);
    }
    setTool(next);
    setAssistantSettings(false);
    setOpen(true);
  };
  const leave = (action: () => void) => {
    close();
    closeWorkspace();
    action();
  };
  const selectRef = useRef(select);
  selectRef.current = select;
  const handledSearchRequest = useRef<typeof searchRequest>(null);
  const taskOpenRequest = useWorkspaceMenu((state) => state.taskOpenRequest);
  const handledTaskOpenRequest = useRef(taskOpenRequest);
  useEffect(() => {
    if (taskOpenRequest === handledTaskOpenRequest.current) return;
    handledTaskOpenRequest.current = taskOpenRequest;
    setOpen(false);
    closeMenu();
    setPanel('tasks');
    setExpanded(true);
    setAssistantSettings(false);
  }, [taskOpenRequest, closeMenu]);
  useEffect(() => {
    if (
      !searchRequest ||
      searchRequest.scope !== accountScope ||
      handledSearchRequest.current === searchRequest
    )
      return;
    handledSearchRequest.current = searchRequest;
    if (searchRequest.tool === 'tasks' || searchRequest.tool === 'assistant') {
      setOpen(false);
      closeMenu();
      setPanel(searchRequest.tool);
      setExpanded(true);
      setAssistantSettings(false);
    } else selectRef.current(searchRequest.tool, searchRequest.exportMode);
  }, [searchRequest, closeMenu, accountScope]);
  const fixedExportScope =
    exportFixedScope &&
    (exportDraft?.draft.selection.owner.kind === 'messages' ||
      (exportDraft?.draft.selection.owner.kind === 'conversations' &&
        exportDraft.draft.selection.scope.type === 'items' &&
        exportDraft.draft.selection.scope.ids.length > 0));

  const items = [
    {
      id: 'export',
      label: '导出',
      icon: <Download size={20} />,
      action: () => select('export'),
    },
    {
      id: 'analysis',
      label: '分析与报告',
      icon: <BarChart3 size={20} />,
      action: () => select('analysis'),
    },
    {
      id: 'viewer',
      label: '导出查看器',
      icon: <FolderOpen size={20} />,
      action: () => select('viewer'),
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
      <Modal
        open={!hidden && (Boolean(anchor) || expanded)}
        presentation={expanded ? 'modal' : 'popover'}
        centered={expanded}
        anchor={anchor}
        onClose={closeWorkspace}
        width={expanded ? 1100 : 392}
        className={`weq-workspace-menu${expanded ? ' is-expanded' : ' is-compact'}`}
        labelledBy="weq-workspace-menu-title"
      >
        <header className="weq-workspace-menu-head">
          <h2 id="weq-workspace-menu-title">{panel === 'tasks' ? '任务' : 'WeQ 助手'}</h2>
          <button
            type="button"
            title={expanded ? '收起到菜单' : '打开完整面板'}
            aria-label={
              expanded ? '收起到菜单' : `打开完整${panel === 'tasks' ? '任务' : '助手'}面板`
            }
            onClick={() => {
              if (expanded) {
                if (!anchor) {
                  const trigger =
                    lastAnchor.current ??
                    [...document.querySelectorAll<HTMLElement>('.weq-workspace-menu-trigger')].find(
                      (element) => element.getClientRects().length > 0,
                    );
                  if (trigger) useWorkspaceMenu.getState().toggle(trigger);
                }
                setExpanded(false);
              } else {
                setExpanded(true);
              }
            }}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          {panel === 'tasks' && running ? <small>{running} 项进行中</small> : null}
          <div className="weq-workspace-menu-head-actions">
            {panel === 'assistant' && expanded ? (
              <button
                type="button"
                title="QQ 公众号推送设置"
                aria-label="QQ 公众号推送设置"
                aria-pressed={assistantSettings}
                onClick={() => setAssistantSettings((value) => !value)}
              >
                <Settings size={17} />
              </button>
            ) : null}
            <button
              type="button"
              title={
                panel === 'tasks'
                  ? `切换到 WeQ 助手${assistantActivity === 'running' ? ' · 回答中' : assistantActivity === 'finished' ? ' · 回答已结束' : ''}`
                  : `切换到任务列表${running ? ` · ${running} 项进行中` : ''}${finished ? ` · ${finished} 项已结束` : ''}${failed ? ` · ${failed} 项失败` : ''}`
              }
              aria-label={panel === 'tasks' ? '切换到 WeQ 助手' : '切换到任务列表'}
              onClick={() => {
                setPanel(panel === 'tasks' ? 'assistant' : 'tasks');
                setAssistantSettings(false);
              }}
            >
              {panel === 'tasks' ? <AssistantIcon size={18} /> : <ListTodo size={18} />}
              <WorkspaceStatusDot
                running={panel === 'assistant' ? running : Number(assistantActivity === 'running')}
                finished={panel === 'assistant' ? finished : Number(assistantUnread)}
              />
            </button>
            {expanded ? (
              <button type="button" title="关闭" aria-label="关闭完整面板" onClick={closeWorkspace}>
                <X size={18} />
              </button>
            ) : null}
          </div>
        </header>
        <div className="weq-workspace-menu-body">
          <RetainedTabs snapshotKey="workspace-tools" activeKey="tasks">
            {!hidden && (anchor || expanded) && panel === 'tasks' ? (
              <ExportTool
                surface="tasks"
                taskLayout={expanded ? 'split' : 'compact'}
                onTaskExpand={() => setExpanded(true)}
                onNewSchedule={() => openExport(null, { mode: 'scheduled' })}
                onOpenClone={(id) => leave(() => onOpenClone?.(id))}
              />
            ) : null}
          </RetainedTabs>
          <div
            className="weq-menu-assistant"
            hidden={
              hidden ||
              !(anchor || expanded) ||
              panel !== 'assistant' ||
              (assistantSettings && expanded)
            }
          >
            <TabActivity
              active={
                !hidden &&
                Boolean(anchor || expanded) &&
                panel === 'assistant' &&
                (!assistantSettings || !expanded)
              }
            >
              <AssistantMenuWorkspace
                accountScope={accountScope}
                compact={!expanded}
                searchTarget={assistantSearchTarget}
              />
            </TabActivity>
          </div>
          {!hidden &&
          (anchor || expanded) &&
          panel === 'assistant' &&
          assistantSettings &&
          expanded ? (
            <div className="weq-assistant-service-settings">
              <AssistantSection />
            </div>
          ) : null}
        </div>
        {!expanded ? (
          <>
            <nav className="weq-workspace-actions" aria-label="内容工具">
              {[...items]
                .sort(
                  (a, b) =>
                    ['analysis', 'export', 'viewer', 'composition'].indexOf(a.id) -
                    ['analysis', 'export', 'viewer', 'composition'].indexOf(b.id),
                )
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.id === 'export' ? entry.label : item.label}
                    aria-label={item.label}
                    onPointerEnter={() => preloadWorkspace(item.id)}
                    onFocus={() => preloadWorkspace(item.id)}
                    onClick={item.action}
                  >
                    {item.icon}
                    <span>{ACTION_LABELS[item.id]}</span>
                  </button>
                ))}
            </nav>
            {footerControls}
          </>
        ) : null}
      </Modal>
      <Modal
        presentation="modal"
        dismissOnOutside={false}
        open={open && tool !== 'backfill'}
        onClose={close}
        width={1000}
        className="weq-tools-modal"
        labelledBy="weq-tools-title"
      >
        <header className="weq-tools-header">
          <h2 id="weq-tools-title">{TITLES[tool]}</h2>
          {tool === 'export' && exportAuthorization?.needed ? (
            <button
              type="button"
              className="weq-export-needs-elevation"
              onClick={exportAuthorization.request}
            >
              <ShieldAlert size={15} />
              需要提权
            </button>
          ) : null}
          <button type="button" onClick={close} title="关闭工具" aria-label="关闭工具">
            <X size={18} />
          </button>
        </header>
        <RetainedTabs
          snapshotKey="workspace-export"
          key={accountKey ?? 'no-account'}
          activeKey={open && tool !== 'backfill' ? tool : 'closed'}
        >
          {open && tool !== 'backfill' ? (
            tool === 'export' ? (
              <ExportTool
                onAuthorizationChange={setExportAuthorization}
                key={JSON.stringify([
                  exportDraft?.draft.accountId === accountKey ? exportDraft.key : 'empty',
                  fixedExportScope,
                  exportMode,
                  exportBaseline,
                ])}
                initialSelection={
                  exportDraft?.draft.accountId === accountKey
                    ? exportDraft.draft.selection
                    : undefined
                }
                initialMode={exportMode}
                initialBaselineDirectory={exportBaseline}
                onClose={close}
                fixedScope={fixedExportScope}
                contentListRevision={fixedExportScope ? undefined : exportListRevision}
              />
            ) : tool === 'viewer' ? (
              <ExportViewer
                onNavigate={close}
                onIncrement={(source) => {
                  if (!source.conversation || !source.baselineDirectory) return;
                  openExport(
                    {
                      owner: {
                        kind: 'messages',
                        container: `${source.conversation.kind}:${source.conversation.conv}`,
                      },
                      scope: { type: 'all' },
                    },
                    { fixed: true, mode: 'full', baselineDirectory: source.baselineDirectory },
                  );
                }}
              />
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
          snapshotKey="workspace-analysis"
          key={accountKey ?? 'no-account'}
          activeKey={open && tool === 'backfill' ? 'backfill' : 'closed'}
        >
          {open && tool === 'backfill' ? (
            <RoamingBackfillPanel
              key={JSON.stringify([accountKey, roamingTargets, roamingSeed])}
              initialTargets={roamingTargets}
              targetMode={roamingTargets.length ? 'fixed' : 'select'}
              onSubmitted={() => useWorkspaceMenu.getState().openTasks()}
            />
          ) : null}
        </RetainedTabs>
      </Modal>
    </>
  );
}
