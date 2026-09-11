/**
 * WeQ 助手面板：与会调用内置工具 + 外部 MCP 工具的多轮任务型助手对话。
 *
 * 一次提问 = 一个任务：后端多轮推进，过程（思考/工具调用/工具结果）经
 * `account.onAssistantEvent` 订阅实时流式推送，前端逐步展示（可折叠），最终答复
 * 用 Markdown 渲染。模型与思考等级在输入框上方就近切换（即改即存）；顶部设置
 * 弹窗配置：额外提示 / 外部 MCP 服务器。空会话展示预设问题，点击直接发送。
 *
 * 流式部分见下面两处：事件按动画帧合并 flush（`flush`），正文段的归档时机由 `applySteps`
 * 的 `handoffIndex` 控制——工具轮次之间不再把气泡清空，细节见两处注释。
 */

import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Brain,
  Check,
  ChevronDown,
  Cpu,
  Loader2,
  Send,
  Settings,
  Sparkles,
  Square,
} from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { autoGrowTextarea } from '../../lib/textareaAutoGrow';
import { Modal } from '../../components/Dialog';
import type { AssistantStep } from '@weq/service';
import { ChatBubble } from './ChatBubble';
import { AssistantMessage } from './AssistantMessage';
import { AssistantSteps } from './AssistantSteps';
import { AssistantArtifactCard } from './AssistantArtifactCard';
import {
  AssistantPlanPanel,
  AssistantNotesPanel,
  AssistantCompactionMarker,
} from './AssistantWorkspace';
import type { FlatModels } from './NewCloneModal';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  steps?: AssistantStep[];
  running?: boolean;
  /** 运行中逐字累积的正文（final 到达后清空，改用 text）。 */
  streamingText?: string;
  /** 运行中逐字累积的推理内容（reasoning_delta），喂给思考面板。 */
  reasoning?: string;
  /**
   * 「当前这段正文」在 `steps` 里待归档的下标。工具调用等过程步骤到来时先记下位置，
   * 但**不立刻**把正文从气泡挪走——否则气泡会瞬间清空、已读到的字像被撤回；
   * 等下一段正文开始（或 final/aborted）再插回该位置，顺序与后端持久化一致。
   */
  handoffIndex?: number;
}

/** 后端会在这些过程步骤之前记一条 thinking（`record({kind:'thinking'})`），故它们是一次正文段的边界。 */
const SEGMENT_BOUNDARY_KINDS: ReadonlySet<AssistantStep['kind']> = new Set([
  'tool_call',
  'plan',
  'notes',
  'compaction',
]);

/**
 * 把一批流式步骤应用到「运行中的最后一条助手回合」。
 *
 * 正文段在过程步骤（工具调用等）到来时只记账（记下 `handoffIndex`）而不搬走，让气泡里的字留到
 * 下一段正文开始；归档位置固定在该批过程步骤**之前**，与后端 `record(thinking)` / `persistable()`
 * 的顺序对齐，重载后视觉一致。纯函数——清 runId、失效查询、报错弹窗等副作用由调用方结算。
 */
function applySteps(turn: Turn, batch: AssistantStep[]): Turn {
  const steps = [...(turn.steps ?? [])];
  const next: Turn = { ...turn, steps };

  /** 把气泡里的正文段归档成一条 thinking（插回它在 steps 中该在的位置）。 */
  const commit = (): void => {
    if (next.handoffIndex == null) return;
    const text = (next.streamingText ?? '').trim();
    if (text)
      steps.splice(Math.min(next.handoffIndex, steps.length), 0, { kind: 'thinking', text });
    next.handoffIndex = undefined;
  };

  for (const step of batch) {
    switch (step.kind) {
      case 'text_delta': {
        // 上一段正文到此结束（它会先归档进 steps），本条 delta 开启新的一段。
        const startsNewSegment = next.handoffIndex != null;
        commit();
        next.streamingText = startsNewSegment ? step.text : (next.streamingText ?? '') + step.text;
        break;
      }
      case 'reasoning_delta':
        // 推理流整轮累积（不按工具轮次清零）：面板里不跳变，且后端也不持久化它。
        next.reasoning = (next.reasoning ?? '') + step.text;
        break;
      case 'final':
        commit();
        next.text = step.text || '（没能得出结论。）';
        next.streamingText = '';
        next.reasoning = '';
        next.running = false;
        break;
      case 'aborted': {
        // 中断在工具轮次之间时，气泡里那段其实是「思考」而非答复（后端同样把它清零了），
        // 所以要先看 handoffIndex 再决定能不能拿它当半截答复。
        const visible = next.handoffIndex != null ? '' : (next.streamingText ?? '').trim();
        commit();
        next.text = visible || next.text || '（已停止）';
        next.streamingText = '';
        next.reasoning = '';
        next.running = false;
        break;
      }
      case 'error':
        next.running = false;
        break;
      default:
        if (SEGMENT_BOUNDARY_KINDS.has(step.kind) && next.handoffIndex == null) {
          next.handoffIndex = steps.length;
        }
        steps.push(step);
    }
  }
  return next;
}

function parseSel(key: string): { providerId: string; model: string } | undefined {
  const [providerId, model] = key.split('::');
  return providerId && model ? { providerId, model } : undefined;
}

/** 下拉里的分组：一个 provider 一组，组内多个模型选项。 */
interface SelectGroup {
  label: string;
  options: Array<{ value: string; label: string }>;
}

/**
 * 把扁平模型列表按 provider 分组（label 形如 `Provider · Model`：组标题取 provider，
 * 选项标题取 model 部分，去掉冗余的 provider 前缀让下拉更清爽）。保持原有顺序。
 */
function buildModelGroups(models: FlatModels['chat']): SelectGroup[] {
  const groups: SelectGroup[] = [];
  const byProvider = new Map<string, SelectGroup>();
  for (const m of models) {
    const sep = m.label.indexOf(' · ');
    const provider = sep >= 0 ? m.label.slice(0, sep) : m.label;
    const modelLabel = sep >= 0 ? m.label.slice(sep + 3) : m.label;
    let group = byProvider.get(m.providerId);
    if (!group) {
      group = { label: provider, options: [] };
      byProvider.set(m.providerId, group);
      groups.push(group);
    }
    group.options.push({ value: m.key, label: modelLabel });
  }
  return groups;
}

/**
 * 输入框上方的紧凑下拉（模型 / 思考等级共用）。
 *
 * 原生 <select> 在这里既丑又难与主题一致，改成自定义 popover：触发器是一颗胶囊，
 * 点开在其上方弹出圆角卡片（用 portal + fixed 定位，避免被会话滚动区裁剪 / 撑高）。
 * 选项可按 provider 分组、当前项高亮打勾。纯展示，选中回调交给父组件落库。
 */
function ComposerSelect({
  icon,
  title,
  placeholder,
  value,
  groups,
  disabled,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  placeholder: string;
  value: string;
  groups: SelectGroup[];
  disabled?: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; minWidth: number } | null>(null);

  const flat = groups.flatMap((g) => g.options);
  const current = flat.find((o) => o.value === value);
  const hasGroups = groups.length > 1 || (groups[0]?.label ?? '') !== '';

  // 打开时按触发器位置把 popover 贴到其正上方；随后点外部 / 滚动 / Esc 关闭。
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: r.left,
      bottom: window.innerHeight - r.top + 6,
      minWidth: r.width,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    function onDocDown(e: MouseEvent): void {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`weq-asst-select${open ? ' is-open' : ''}`}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="weq-asst-select-icon">{icon}</span>
        <span className={`weq-asst-select-value${current ? '' : ' is-placeholder'}`}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={13} className="weq-asst-select-caret" aria-hidden />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={popRef}
              className="weq-asst-select-pop"
              role="listbox"
              style={{ left: pos.left, bottom: pos.bottom, minWidth: pos.minWidth }}
            >
              {groups.map((g, gi) => (
                <div key={g.label || `g-${gi}`} className="weq-asst-select-group">
                  {hasGroups && g.label ? (
                    <div className="weq-asst-select-group-label">{g.label}</div>
                  ) : null}
                  {g.options.map((o) => {
                    const active = o.value === value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`weq-asst-select-opt${active ? ' is-active' : ''}`}
                        onClick={() => {
                          onChange(o.value);
                          setOpen(false);
                        }}
                      >
                        <span className="weq-asst-select-opt-label">{o.label}</span>
                        {active ? <Check size={14} aria-hidden /> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** 思考等级选项：非「不思考」时以 reasoning_effort 传给模型（M2）。 */
const EFFORT_OPTIONS = [
  { value: 'off', label: '不思考' },
  { value: 'low', label: '轻度思考' },
  { value: 'medium', label: '标准思考' },
  { value: 'high', label: '深度思考' },
] as const;

type EffortValue = (typeof EFFORT_OPTIONS)[number]['value'];

/** 空状态预设问题：点一下直接发送，让新用户知道助手能干什么。 */
const PRESET_QUESTIONS = [
  '我最近一周和谁聊得最火热？',
  '看看我最活跃的群最近都在聊什么',
  '帮我写一份我的聊天数据周报',
  '找找最近有谁跟我约过「吃饭」',
];

function AssistantSettings({ onClose }: { onClose: () => void }): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const config = trpc.account.getAssistantConfig.useQuery();
  const save = trpc.account.setAssistantConfig.useMutation();
  const [prompt, setPrompt] = useState('');
  const [mcp, setMcp] = useState('');

  useEffect(() => {
    const c = config.data;
    if (!c) return;
    setPrompt(c.customPrompt ?? '');
    setMcp(c.mcpServers ?? '');
  }, [config.data]);

  async function onSave(): Promise<void> {
    try {
      await save.mutateAsync({
        customPrompt: prompt,
        mcpServers: mcp,
      });
      await utils.account.getAssistantConfig.invalidate();
      dialog.success('已保存', '助手设置已更新');
      onClose();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal onClose={onClose} width={520}>
      <div className="weq-persona-modal">
        <header className="weq-persona-modal-head">
          <Settings size={16} />
          <strong>WeQ 助手设置</strong>
        </header>
        <div className="weq-clone-config">
          <label className="weq-agentlab-field">
            <span>额外提示（可选）</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="例如：回答尽量简洁"
            />
          </label>
          <label className="weq-agentlab-field">
            <span>外部 MCP 服务器（可选）</span>
            <textarea
              value={mcp}
              onChange={(e) => setMcp(e.target.value)}
              rows={4}
              placeholder={
                '远程 HTTP/SSE 服务器，两种写法任选：\n' +
                '① 每行一个：名字=https://example.com/mcp\n' +
                '② Claude Desktop JSON：{"mcpServers":{"名字":{"url":"https://…","headers":{"Authorization":"Bearer …"}}}}'
              }
            />
          </label>
          <div className="weq-asst-set-hint">
            外部工具会在对话中自动合并进可用工具（命名空间 <code>mcp__服务器__工具</code>
            ），连接在首次使用时建立； 某个服务器不可用不会影响内置工具。
          </div>
          <div className="weq-clone-actions">
            <button className="weq-set-btn weq-set-btn-soft" onClick={onClose}>
              取消
            </button>
            <button className="weq-set-btn" disabled={save.isLoading} onClick={() => void onSave()}>
              保存
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 助手回复气泡：折叠过程 + Markdown 终答 + 附件卡片。
 * `memo` 隔离：流式期间只有「正在跑的最后一条」变化，历史气泡不因父组件 setTurns 重渲。
 */
const AssistantBubble = memo(function AssistantBubble({ turn }: { turn: Turn }): ReactElement {
  const steps = turn.steps ?? [];
  const artifacts = steps
    .filter((s): s is Extract<AssistantStep, { kind: 'artifact' }> => s.kind === 'artifact')
    .map((s) => s.artifact);
  // 调查过程（计划/笔记/压缩标记）取 steps 里最新一次快照，随运行逐步刷新。
  const plan = steps
    .filter((s): s is Extract<AssistantStep, { kind: 'plan' }> => s.kind === 'plan')
    .at(-1)?.plan;
  const notes = steps
    .filter((s): s is Extract<AssistantStep, { kind: 'notes' }> => s.kind === 'notes')
    .at(-1)?.notes;
  const compaction = steps
    .filter((s): s is Extract<AssistantStep, { kind: 'compaction' }> => s.kind === 'compaction')
    .at(-1);
  // 运行中显示逐字流式缓冲，完成后显示定稿正文。
  const body = turn.running ? turn.streamingText || turn.text : turn.text;

  return (
    <div className="message-line theirs">
      <span className="avatar weq-asst-avatar">
        <Sparkles size={18} />
      </span>
      <div className="message-bubble">
        <span className="message-name">
          WeQ 助手
          <small className="bot-badge" aria-label="AI">
            <Sparkles size={11} strokeWidth={2.4} />
          </small>
        </span>
        <div className="message-content weq-asst-content">
          {plan ? <AssistantPlanPanel plan={plan} /> : null}
          <AssistantSteps steps={steps} running={!!turn.running} reasoning={turn.reasoning} />
          {body ? (
            <AssistantMessage text={body} streaming={!!turn.running} />
          ) : turn.running ? (
            <div className="weq-agentlab-typing weq-asst-typing">
              <span />
              <span />
              <span />
            </div>
          ) : null}
          {notes ? <AssistantNotesPanel notes={notes} running={!!turn.running} /> : null}
          {compaction ? (
            <AssistantCompactionMarker
              summary={compaction.summary}
              foldedTurns={compaction.foldedTurns}
            />
          ) : null}
          {artifacts.map((a) => (
            <AssistantArtifactCard key={a.id} artifact={a} />
          ))}
        </div>
      </div>
    </div>
  );
});

export function AssistantPanel({
  sessionId,
  chatModels,
  onBack,
  onSessionCreated,
}: {
  /** 真实会话 id；`null` 表示草稿会话——用户真正发第一条消息时才落库。 */
  sessionId: string | null;
  chatModels: FlatModels['chat'];
  onBack: () => void;
  /** 草稿会话首次发送、后端建好真会话后回调（父组件据此刷新列表 + 更新选中态）。 */
  onSessionCreated: (sessionId: string) => void;
}): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  // 挂载时快照初始 id：草稿(null) 与既有会话在本组件生命周期内身份固定，
  // 后续父组件把草稿升级成真会话（sessionId 由 null 变真）不重新拉历史，避免闪断。
  const initialSessionId = useRef(sessionId).current;
  // 可变的当前会话 id：草稿首次发送时被写成真 id，之后所有读写都走它。
  const sessionIdRef = useRef<string | null>(sessionId);
  const conversation = trpc.account.getAssistantConversation.useQuery(
    { sessionId: initialSessionId ?? '' },
    { enabled: !!initialSessionId },
  );
  const selfProfile = trpc.account.getSelfProfile.useQuery();
  const assistantConfig = trpc.account.getAssistantConfig.useQuery();
  const send = trpc.account.chatWithAssistant.useMutation();
  const createSession = trpc.account.createAssistantSession.useMutation();
  const abort = trpc.account.abortAssistantRun.useMutation();
  const resumeRun = trpc.account.resumeAssistantRun.useMutation();
  const clear = trpc.account.clearAssistantConversation.useMutation();
  const saveConfig = trpc.account.setAssistantConfig.useMutation();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 已请求停止、正在等后端收尾（在途 LLM 请求要等它返回/被 signal 掐断才 emit aborted）。
  const [stopping, setStopping] = useState(false);
  // 当前真实会话 id（草稿升级后跟随更新；resume 查询依赖它，不能用挂载时的快照）。
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(sessionId);
  const seeded = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 是否贴底跟随：用户往上翻阅历史时不抢滚动条，回到底部附近才恢复。 */
  const stickRef = useRef(true);

  // 该会话是否有上次中断留下的断点任务（“继续回答”入口）。final/aborted 后失效刷新。
  const resumeQuery = trpc.account.getAssistantResumeState.useQuery(
    { sessionId: currentSessionId ?? '' },
    { enabled: !!currentSessionId },
  );

  const busy = turns.some((t) => t.running);
  const resumable = !busy && resumeQuery.data?.resumable === true;

  // 轮次结束（final / aborted / error）后 busy 转 false，把「停止中」复位。
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);
  const modelSel = assistantConfig.data?.model
    ? `${assistantConfig.data.model.providerId}::${assistantConfig.data.model.model}`
    : '';
  const effort: EffortValue = assistantConfig.data?.reasoningEffort ?? 'medium';
  const modelGroups = buildModelGroups(chatModels);

  /** 让当前会话的持久化对话缓存失效（会话 id 走 ref，草稿升级后仍指向真会话）。 */
  function invalidateConversation(): void {
    const id = sessionIdRef.current;
    if (id) void utils.account.getAssistantConversation.invalidate({ sessionId: id });
  }
  // 事件订阅只该建一次，所以通过 ref 拿最新实现，而不是把它当依赖。
  const invalidateConversationRef = useRef(invalidateConversation);
  invalidateConversationRef.current = invalidateConversation;

  /** 输入框旁的快捷设置：改了立即落库（与设置弹窗共用同一份配置）。 */
  async function onQuickConfig(patch: { modelKey?: string; effort?: EffortValue }): Promise<void> {
    try {
      await saveConfig.mutateAsync({
        ...(patch.modelKey !== undefined ? { model: parseSel(patch.modelKey) } : {}),
        ...(patch.effort !== undefined ? { reasoningEffort: patch.effort } : {}),
      });
      await utils.account.getAssistantConfig.invalidate();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  }

  // 首次加载持久化对话（含历史的折叠过程）。
  useEffect(() => {
    if (!seeded.current && conversation.data) {
      setTurns(
        conversation.data.map((t) => ({
          role: t.role,
          text: t.text,
          steps: t.steps,
        })),
      );
      seeded.current = true;
    }
  }, [conversation.data]);

  // 实时过程流：累积进"运行中"的最后一条助手回合。镜像 UpdateCard 的订阅范式。
  //
  // 事件先入缓冲、按动画帧合并 flush：LLM 一个 token 就是一条事件，逐条 setState 会让每次输出
  // 都触发一次重渲 + 整段 Markdown 重解析 + 强制滚动，高速输出下直接掉帧。合并后每秒最多 60 次。
  useEffect(() => {
    let frame: number | null = null;
    const pending: AssistantStep[] = [];

    const flush = (): void => {
      frame = null;
      const batch = pending.splice(0, pending.length);
      if (batch.length === 0) return;
      setTurns((prev) => {
        const idx = prev.length - 1;
        const turn = prev[idx];
        if (turn?.role !== 'assistant') return prev;
        const next = [...prev];
        next[idx] = applySteps(turn, batch);
        return next;
      });
      // 副作用在 setTurns 之外结算：保持上面 updater 纯净（StrictMode 会跑两遍）。
      const failed = batch.find(
        (s): s is Extract<AssistantStep, { kind: 'error' }> => s.kind === 'error',
      );
      if (failed) {
        runIdRef.current = null;
        dialog.error('助手出错', failed.message);
        return;
      }
      if (batch.some((s) => s.kind === 'final' || s.kind === 'aborted')) {
        runIdRef.current = null;
        invalidateConversationRef.current();
        // 首轮对话后端会自动总结标题；刷新会话列表让左栏标题跟上。
        void utils.account.listAssistantSessions.invalidate();
        // 完成/中断后断点快照被清除或已保存，刷新「继续回答」状态。
        void utils.account.getAssistantResumeState.invalidate({
          sessionId: sessionIdRef.current ?? '',
        });
      }
    };

    const sub = client.account.onAssistantEvent.subscribe(undefined, {
      onData: ({ runId, step }) => {
        if (runId !== runIdRef.current) return;
        pending.push(step);
        if (frame == null) frame = requestAnimationFrame(flush);
      },
      onError: (err) => console.error('[assistant] event subscription error', err),
    });
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      sub.unsubscribe();
    };
    // 订阅只按 runIdRef 匹配，会话 id 走 ref，不必因 id 变化重订阅。
  }, [utils, dialog]);

  // 新内容时滚到底部（仅当用户本就贴着底部）。
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function onTranscriptScroll(): void {
    const el = transcriptRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  async function onSend(preset?: string): Promise<void> {
    const raw = preset ?? input;
    if (!raw.trim() || busy) return;
    // 没配聊天模型时后端会直接抛错、且这条 rejection 被路由吞掉（不会 emit error
    // 事件），前端就会永久转圈。发送前先拦下来，给出可操作的提示而不是加载动画。
    if (!assistantConfig.data?.model) {
      await dialog.confirm(
        '还没配置聊天模型',
        chatModels.length === 0
          ? '请先在 AgentLab 里添加一个带「聊天」能力的模型，再回到助手这里选择它。'
          : '请先在输入框上方选择一个聊天模型。',
        { okLabel: '知道了', tone: 'warning' },
      );
      return;
    }
    const text = raw.trim();
    if (!preset) {
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
    }
    // 自己发的消息总是要跟到底部（哪怕刚在翻历史）。
    stickRef.current = true;
    setTurns((prev) => [
      ...prev,
      { role: 'user', text },
      { role: 'assistant', text: '', steps: [], running: true },
    ]);
    try {
      // 草稿会话：真正发第一条消息时才落库建会话，拿到真 id 后续都走它。
      // 建好立刻通知父组件刷新列表 + 把选中态指向新会话（不换组件 key，避免闪断）。
      let id = sessionIdRef.current;
      if (!id) {
        const session = await createSession.mutateAsync();
        id = session.id;
        sessionIdRef.current = id;
        setCurrentSessionId(id);
        seeded.current = true; // 新会话无历史可 seed，别再被首帧空对话覆盖本地 turns。
        await utils.account.listAssistantSessions.invalidate();
        onSessionCreated(id);
      }
      // 新问题会取代上次中断的任务（后端已清掉断点快照），刷新“继续回答”状态。
      void utils.account.getAssistantResumeState.invalidate({ sessionId: id });
      const { runId } = await send.mutateAsync({ sessionId: id, text });
      runIdRef.current = runId;
    } catch (e) {
      dialog.error('发送失败', e instanceof Error ? e.message : String(e));
      // 回滚刚加入的两条。
      setTurns((prev) => prev.slice(0, -2));
      if (!preset) setInput(text);
    }
  }

  async function onClear(): Promise<void> {
    const ok = await dialog.confirm('清空对话', '确认清空当前这段对话的内容？', {
      okLabel: '清空',
      tone: 'warning',
    });
    if (!ok) return;
    const id = sessionIdRef.current;
    // 草稿会话还没落库，直接清本地即可。
    if (id) {
      await clear.mutateAsync({ sessionId: id });
      invalidateConversation();
      await utils.account.listAssistantSessions.invalidate();
      // 清空对话同时作废了断点任务，刷新“继续回答”状态。
      void utils.account.getAssistantResumeState.invalidate({ sessionId: id });
    }
    setTurns([]);
    stickRef.current = true;
    runIdRef.current = null;
  }

  /** 停止当前任务：请求后端掐断（真正收尾 + 持久化半截答复由后端 emit `aborted` 驱动）。 */
  async function onStop(): Promise<void> {
    if (stopping) return;
    // 先给即时反馈：掐断要走 IPC，且后端要等在途的 LLM 请求返回才能收尾，
    // 这期间按钮停在「停止中…」，否则点了像没反应。
    setStopping(true);
    const runId = runIdRef.current;
    // runId 还没回来（发送仍在建会话/起任务）：等 busy 结束由上面的 effect 复位。
    if (!runId) return;
    try {
      await abort.mutateAsync({ runId });
    } catch (e) {
      setStopping(false);
      dialog.error('停止失败', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 断点续答：把最后一条（半截）assistant 回合重新标记为运行中，然后请求后端从快照继续。
   * 后续事件流与正常轮次完全一致（工具调用/正文流式/最终答复）。
   */
  async function onResume(): Promise<void> {
    const id = sessionIdRef.current;
    if (!id || busy) return;
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') {
        next[next.length - 1] = {
          ...last,
          running: true,
          streamingText: '',
          reasoning: '',
          handoffIndex: undefined,
        };
      } else {
        // 兜底：没有可续的 assistant 回合时补一条空的。
        next.push({ role: 'assistant', text: '', steps: [], running: true });
      }
      return next;
    });
    try {
      const { runId } = await resumeRun.mutateAsync({ sessionId: id });
      runIdRef.current = runId;
    } catch (e) {
      dialog.error('继续失败', e instanceof Error ? e.message : String(e));
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant') next[next.length - 1] = { ...last, running: false };
        return next;
      });
    }
  }

  return (
    <div className="weq-agentlab-chat">
      <header className="weq-agentlab-head">
        <div className="weq-agentlab-head-left">
          <button
            type="button"
            className="weq-set-iconbtn"
            onClick={onBack}
            aria-label="返回主页"
            title="返回"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <strong>WeQ 助手</strong>
            <span>把问题交给它：会自己查聊天记录、找联系人、多轮推进直到给出结论。</span>
          </div>
        </div>
        <div className="weq-agentlab-head-actions">
          <button
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={12} /> 设置
          </button>
          <button
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            disabled={busy}
            onClick={() => void onClear()}
          >
            清空
          </button>
        </div>
      </header>

      {resumable ? (
        <div className="weq-asst-resume-bar">
          <span>
            上次回答被中断，已执行 {resumeQuery.data?.toolCallCount ?? 0} 次工具调用
            {resumeQuery.data?.question ? `（「${resumeQuery.data.question.slice(0, 40)}」）` : ''}
            。可从中断处继续，已完成的调查不重查。
          </span>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-sm"
            disabled={resumeRun.isLoading}
            onClick={() => void onResume()}
          >
            {resumeRun.isLoading ? '继续中…' : '继续回答'}
          </button>
        </div>
      ) : null}

      <div className="weq-agentlab-transcript" ref={transcriptRef} onScroll={onTranscriptScroll}>
        {turns.length === 0 ? (
          <div className="weq-agentlab-empty weq-asst-empty">
            <span className="weq-asst-empty-icon">
              <Sparkles size={26} strokeWidth={1.6} />
            </span>
            <strong>把任务交给 WeQ 助手</strong>
            <span>它会自己查聊天记录、找联系人、多轮推进直到给出结论。试试：</span>
            <div className="weq-asst-presets">
              {PRESET_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="weq-asst-preset"
                  disabled={busy}
                  onClick={() => void onSend(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) =>
            t.role === 'user' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
              <ChatBubble key={`u-${i}`} mine name="我" uin={selfProfile.data?.uin} text={t.text} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
              <AssistantBubble key={`a-${i}`} turn={t} />
            ),
          )
        )}
      </div>

      <div className="weq-asst-composer">
        <div className="weq-asst-composer-tools">
          <ComposerSelect
            icon={<Cpu size={13} />}
            title="聊天模型"
            placeholder="选择模型…"
            value={modelSel}
            groups={modelGroups}
            disabled={busy || saveConfig.isLoading}
            onChange={(v) => void onQuickConfig({ modelKey: v })}
          />
          <ComposerSelect
            icon={<Brain size={13} />}
            title="思考等级"
            placeholder="思考等级"
            value={effort}
            groups={[
              {
                label: '',
                options: EFFORT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
              },
            ]}
            disabled={busy || saveConfig.isLoading}
            onChange={(v) => void onQuickConfig({ effort: v as EffortValue })}
          />
        </div>
        <div className="weq-agentlab-composer weq-asst-composer-row">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrowTextarea(e.currentTarget);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            placeholder="把任务交给 WeQ 助手（Enter 发送，Shift+Enter 换行）"
            disabled={busy}
          />
          {busy ? (
            <button
              className="weq-set-btn weq-asst-stop-btn"
              onClick={() => void onStop()}
              disabled={stopping}
              aria-busy={stopping}
              title={stopping ? '正在停止本轮任务…' : '停止本轮任务'}
            >
              {stopping ? (
                <>
                  <Loader2 size={13} strokeWidth={2.4} className="weq-asst-spin" /> 停止中…
                </>
              ) : (
                <>
                  <Square size={13} strokeWidth={2.6} /> 停止
                </>
              )}
            </button>
          ) : (
            <button className="weq-set-btn" onClick={() => void onSend()} disabled={!input.trim()}>
              <Send size={14} /> 发送
            </button>
          )}
        </div>
      </div>

      {settingsOpen ? <AssistantSettings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
