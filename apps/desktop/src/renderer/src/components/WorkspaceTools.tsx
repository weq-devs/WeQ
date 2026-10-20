import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getCloneTasks, subscribeCloneTasks } from '../views/agentlab/cloneTaskStore';
import type { GeneratedSearchHit } from './search/types';
import {
  BarChart3,
  Bookmark,
  Bot,
  Contact,
  Database,
  Download,
  FileStack,
  FolderOpen,
  Globe,
  Images,
  ListTodo,
  MessagesSquare,
  Radio,
  Settings,
  Smile,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { Modal } from './Dialog';
import {
  FloatingToolsBar,
  type FloatingToolChild,
  type FloatingToolItem,
} from './FloatingToolsBar';
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
import { initialExportMode } from '../views/export/exportScope';
import type {
  AnalysisKind,
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
  analysisEntryLabel,
  analysisTargetForWorkspace,
  defaultSelectionForContext,
  exportEntryForWorkspace,
  type WorkspaceContext,
} from '../lib/toolTargets';

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
  workspace,
  analysisRequest,
  roamingRequest,
  onOpenClone,
}: {
  onOpenAnalysis: (report: AnalysisReportRequest) => void;
  onOpenComposition?: () => void;
  assistantSearchTarget?: GeneratedSearchHit | null;
  hidden?: boolean;
  currentConversation?: Conversation | null;
  /** 当前界面上下文：主按钮据此决定进入哪个工具、带哪份内容。 */
  workspace?: WorkspaceContext;
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
  const [exportMode, setExportMode] = useState<ExportMode | undefined>();
  /** 浮动工具子项显式选的类型：面板里不再出现「内容种类」选择器。 */
  const [typePinned, setTypePinned] = useState(false);
  const [exportListRevision, setExportListRevision] = useState(0);
  const [roamingTargets, setRoamingTargets] = useState<RoamingTarget[]>([]);
  const [analysisSeed, setAnalysisSeed] = useState(0);
  /** 浮动工具子项选定的报告种类（无对象，只决定报告类型的默认值）。 */
  const [analysisPresetKind, setAnalysisPresetKind] = useState<AnalysisKind | undefined>();
  const [roamingSeed, setRoamingSeed] = useState(0);
  const [taskAnchor, setTaskAnchor] = useState<HTMLElement | null>(null);
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
    // 记录这次显式请求的来源选择，供「关闭后再点主按钮」复用同一面板现场。
    requestedSelection.current = exportRequest.selection;
    setExportFixedScope(true);
    // 显式请求已经把内容定死了，种类下拉同样没有意义。
    setTypePinned(true);
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
  // 没传 workspace 时是全局工具入口（悬浮按钮）：此时还没有「当前界面」，
  // 主按钮应打开完整选择器，而不是因为推导不出目标就禁用。
  const fresh = !workspace;
  const ctx: WorkspaceContext = workspace ?? {
    view: 'messages',
    conversation: currentConversation ?? null,
  };
  const entry = exportEntryForWorkspace(ctx);
  const analysisEntry = analysisEntryLabel(ctx, fresh);

  /** 把选中的草稿交给导出面板；`mode` 只由浮动工具子项指定。 */
  const openExport = (
    nextSelection: ContentSelection | null | undefined,
    options: { fixed?: boolean; mode?: ExportMode; pinType?: boolean } = {},
    /** 本次是「重新进入已有草稿」：保留面板现场，只切回导出页。 */
    reenter = false,
  ) => {
    const key = nextSelection && accountKey ? JSON.stringify([accountKey, nextSelection]) : null;
    // 同一份选择重新打开工具时保留面板现场（输入过的草稿、已选格式都还在）。
    // 必须重建的只有两种情况：
    //   1. 浮动工具子项显式换了导出种类；
    //   2. 从「固定范围」快捷入口切回完整选择界面（固定界面没有内容列表）。
    // 同一份草稿再次进入：保留面板现场。
    const sameDraft = Boolean(key && exportDraft?.key === key);
    // 只有「从固定范围切回完整选择界面」必须重建（固定界面没有内容列表）。
    const modeSwitch = options.fixed === false && fixedExportScope;
    // 浮动工具子项显式换了种类也重建；「主按钮 + 同一份草稿」推出来的种类
    // 与草稿自身隐含的种类一致，不算切换。
    const impliedMode =
      exportMode ?? (exportDraft ? initialExportMode(exportDraft.draft.selection) : undefined);
    const kindSwitch = options.pinType === true && options.mode !== impliedMode;
    const reuse = Boolean((reenter && sameDraft) || (sameDraft && !modeSwitch && !kindSwitch));
    if (reuse) {
      // 「是否隐藏内容种类」不影响面板草稿，复用时直接同步即可。
      if (options.pinType !== undefined) setTypePinned(options.pinType === true);
      setExportListRevision((previous) => previous + 1);
      setTool('export');
      setAssistantSettings(false);
      setOpen(true);
      return;
    }
    setExportFixedScope(options.fixed === true);
    setExportMode(options.mode);
    setTypePinned(options.pinType === true);
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
  const select = (next: Tool, anchor?: HTMLElement) => {
    if (next === 'tasks') setTaskAnchor(anchor ?? null);
    if (next === 'export') {
      // 主按钮＝按当前界面直接进入。注意不能把 `entry.selection`（带 selected 的对象）
      // 直接放进 React 依赖里：每次渲染都是新引用，会触发导出面板反复重建。
      // 内容页的多选选区优先（用户刚勾的），否则用当前界面的默认目标。
      if (entry.blocked && !selection) return;
      // 优先级：页面内当前多选 > 内容页显式请求过的内容 > 当前界面位置。
      // 同一份选择再次打开时由 openExport 内部复用面板现场。
      // 主按钮在「固定范围」入口已经打开过时，用户点它想要的是完整选择界面：
      // 显式传固定模式，让 openExport 识别为模式切换并重建面板。
      // 种类由当前界面直接决定，面板里不再出现「内容种类」下拉。
      // 种类跟着「这次要导出的那份内容」走：有具体选区时由选区决定，
      // 否则才用当前界面的默认种类。这样再次打开同一份草稿不会把它改成别的种类。
      const explicit = selection ?? requestedSelection.current ?? defaultSelectionForContext(ctx);
      openExport(explicit, {
        mode: explicit ? initialExportMode(explicit) : entry.mode,
        fixed: false,
        pinType: true,
      });
      return;
    }
    if (next === 'analysis' && analysisEntry.reason && !fresh && !analysisTargetForWorkspace(ctx)) {
      // 键盘触发也要拦住：没有上下文时不打开空的分析面板。
      return;
    }
    if (next === 'analysis') {
      // 主按钮：能确定当前对象（群聊 / 好友私聊）就直接固定它；没有就打开完整选择器，
      // 由使用者在面板里挑（例如从悬浮工具进来、当前在别的页面）。
      const directTarget =
        conversationAnalysisTarget(currentConversation) ?? analysisTargetForWorkspace(ctx);
      // 浮动工具的主按钮是「全局入口」：预选当前位置但允许换类型；只有内容页发来的
      // 明确分析请求（analysisRequest）才把对象锁死。
      setAnalysisFixedTarget(false);
      setAnalysisPresetKind(undefined);
      // 会话入口已经固定在某个会话上时优先用它；否则按当前界面上下文推导。
      setAnalysisTarget(directTarget ?? undefined);
      setAnalysisMessageIds(undefined);
      setAnalysisSeed((previous) => previous + 1);
    }
    setTool(next);
    setAssistantSettings(false);
    setOpen(true);
  };

  /**
   * 浮动工具子项：显式指定导出种类，但**不预选导出内容**。
   * 子项只回答「导哪一类」，具体会话 / 空间 / 收藏在面板里再选。
   */
  const selectExportType = (mode: ExportMode) => {
    openExport(null, { fixed: false, mode, pinType: true });
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
  /** 导出子项：按当前界面把「群相册 / 群文件」这类需要落地对象的种类先选好。 */
  const exportChildren: FloatingToolChild[] = [
    { id: 'full', label: '聊天消息', icon: <MessagesSquare size={14} /> },
    { id: 'guild', label: '频道私聊', icon: <Radio size={14} /> },
    { id: 'qzone', label: 'QQ 空间', icon: <Globe size={14} /> },
    { id: 'collection', label: '收藏', icon: <Bookmark size={14} /> },
    { id: 'contacts', label: '联系人', icon: <Contact size={14} /> },
    { id: 'emojipack', label: '表情包', icon: <Smile size={14} /> },
    { id: 'generated', label: '克隆与助手', icon: <Bot size={14} /> },
    { id: 'database', label: '明文数据库', icon: <Database size={14} /> },
    { id: 'album', label: '群相册', icon: <Images size={14} /> },
    { id: 'groupfile', label: '群文件', icon: <FolderOpen size={14} /> },
  ].map((child) => ({
    id: child.id,
    label: child.label,
    icon: child.icon,
    action: () => selectExportType(child.id as ExportMode),
  }));

  /** 报告子项：只保留能落到具体对象的三种（年度报告没有对象上下文）。 */
  const analysisChildren: FloatingToolChild[] = [
    { id: 'group', label: '群聊报告', icon: <Users size={14} /> },
    { id: 'buddy', label: '好友报告', icon: <UserRound size={14} /> },
    { id: 'member', label: '群成员报告', icon: <Users size={14} /> },
  ].map((child) => ({
    id: child.id,
    label: child.label,
    icon: child.icon,
    action: () => {
      // 子项是「我要做这一类报告」：打开分析工具并切到该种类，由面板选对象。
      setAnalysisFixedTarget(false);
      setAnalysisTarget(undefined);
      setAnalysisMessageIds(undefined);
      setAnalysisSeed((previous) => previous + 1);
      setTool('analysis');
      setAssistantSettings(false);
      setOpen(true);
      setAnalysisPresetKind(child.id as AnalysisKind);
    },
  }));

  const items: FloatingToolItem[] = [
    {
      id: 'export',
      label: '导出',
      hint: entry.blocked ? entry.disabledReason : entry.label,
      icon: <Download size={20} />,
      action: () => select('export'),
      children: exportChildren,
      // 只有「这个界面根本不支持导出」才置灰；消息页没选会话仍可打开面板去选。
      // 注意：disabled 只影响鼠标/触摸，键盘仍能触发 click —— 所以点击处理里
      // 也要再判一次，避免从设置页误开一个空导出面板。
      disabled: Boolean(entry.blocked) && !selection,
      disabledReason: entry.disabledReason,
    },
    {
      id: 'tasks',
      label: '任务',
      icon: <ListTodo size={20} />,
      action: (anchor) => select('tasks', anchor),
    },
    {
      id: 'analysis',
      label: '分析与报告',
      hint: analysisEntry.reason ?? analysisEntry.label,
      icon: <BarChart3 size={20} />,
      action: () => select('analysis'),
      children: analysisChildren,
      disabled: !fresh && !analysisTargetForWorkspace(ctx),
      disabledReason: analysisEntry.reason,
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
                  exportMode,
                ])}
                initialSelection={
                  exportDraft?.draft.accountId === accountKey
                    ? exportDraft.draft.selection
                    : undefined
                }
                initialMode={exportMode}
                hideTypeSwitch={typePinned || fixedExportScope}
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
                initialKind={analysisPresetKind}
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
