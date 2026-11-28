import { NumericText } from './NumericText';
import * as timeFormat from '@weq/time';
/** 防撤回方式、保护范围与记录；设置页摘要和会话工具共用后端状态。 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTabPanelMotion } from '../hooks/useTabPanelMotion';
import {
  Archive,
  Database,
  Network,
  Power,
  ArrowLeft,
  BellRing,
  ChevronRight,
  Pencil,
  RotateCcw,
  Save,
  ShieldCheck,
  ListFilter,
  MessagesSquare,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { trpc } from '../trpc/client';
import { useDialog } from './Dialog.shared';
import { useToast } from './Toast.shared';
import { LoadingIndicator } from './LoadingIndicator';
import { SegmentedControl } from './SegmentedControl';
import { QqProxySettingsLink } from './QqProxyConnection';
import { Card, Row, QueryError, SettingsScopeBadge } from './settings/controls';
import { ConversationPicker } from '../views/export/ConversationPicker';
import { convAvatarUrl, fmtCount, type PickItem } from '../views/export/types';
import { isDataline, deviceAvatarDataUri } from '../lib/deviceAvatar';
import { classifyChatType, datalineName } from '@weq/codec';
import { Avatar } from '../im-template/template/primitives';
import { OverlayLayer } from './OverlayLayer';
import { cn } from '../im-template/template/classNames';
import { ToolSurface } from './ToolSurface';
import { PageShell } from './PageShell';
import { useTabActive } from './RetainedTabs.shared';
import { useAppLock } from '../state/lock';
import { useViewState } from '../state/view';
import { acceptSettingsReply } from '../lib/clientPreferences';
import { NotificationSettingsLink } from './settings/NotificationSettingsLink';
import { NotificationMethodSelect } from './settings/NotificationMethodSelect';
import type { NotificationConversation } from '../lib/notificationSettingsNavigation';
import '../styles/anti-recall-settings.css';

/** 触发器过滤所用的会话类型（与后端 AntiRecallKind 对齐）。 */
type AntiRecallKind = 'c2c' | 'group' | 'dataline';

/** 启用范围：关闭 / 按会话勾选 / 永久全选（不做会话筛选）。 */
type AntiRecallMethod = 'off' | 'weq' | 'proxy' | 'database';
type AntiRecallScope = 'off' | 'selected' | 'all';

type Tab = 'protect' | 'notify' | 'records';

const TABS: { id: Tab; label: string; icon: typeof ShieldCheck }[] = [
  { id: 'protect', label: '保护', icon: ShieldCheck },
  { id: 'notify', label: '通知', icon: BellRing },
  { id: 'records', label: '记录', icon: RotateCcw },
];

const SCOPE_OPTIONS: { value: AntiRecallScope; label: string }[] = [
  { value: 'selected', label: '指定会话' },
  { value: 'all', label: '全部会话' },
];

const METHODS: {
  value: AntiRecallMethod;
  title: string;
  description: string;
  icon: typeof ShieldCheck;
}[] = [
  { value: 'off', title: '关闭', description: '消息按 QQ 的正常流程撤回。', icon: Power },
  {
    value: 'weq',
    icon: Archive,
    title: '仅在 WeQ 中保留',
    description: 'QQ 照常撤回。连接代理时实时留存；未连接时，仅保留 WeQ 及时读到的原文。',
  },
  {
    value: 'proxy',
    icon: Network,
    title: '在 WeQ 和本机 QQ 中保留（代理拦截）',
    description: 'WeQ 运行且 QQ 连接代理时生效。',
  },
  {
    value: 'database',
    icon: Database,
    title: '在 WeQ 和本机 QQ 中保留（数据库触发器拦截）',
    description: '无需代理。触发器生效后，关闭 WeQ 也会继续保护。',
  },
];

interface Target {
  kind: AntiRecallKind;
  id: string;
}

/** 最近会话 wire —— 这里只读用到的字段（与 listConversationsWithCount 对齐）。 */
interface ConvWire {
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  targetDisplayName: string;
  messageCount?: number;
}

/** 通知开关的会话 key（与后端 `notifyKey` 一致）。 */
function notifyKeyOf(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * 判定一个会话该用哪个触发器（过滤列）。
 *
 * 不能只看 chatType：有些临时会话（群临时会话 / 频道等）chatType 名字里带 'GROUP'，
 * 但 targetUid 却是 `u_` 开头的 uid，消息实际落在 c2c_msg_table。真群号一定是纯数字，
 * uid 一定是 `u_` 开头，所以以 id 的形态为准。
 */
function kindOf(chatType: string | number, id: string): AntiRecallKind {
  const kind = classifyChatType(chatType);
  if (kind === 'dataline') return 'dataline';
  if (id.startsWith('u_')) return 'c2c';
  if (kind === 'group') return 'group';
  return 'c2c';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** 时间戳（unix 秒）→ 「今天 12:30」/「8/12 12:30」。 */
function formatWhen(ts: number): string {
  return ts > 0 ? timeFormat.formatUnixTime(ts) : '';
}

export function AntiRecallDialog({
  onClose,
  onOpenRecalls,
  embedded = false,
  recallDetails,
  onCloseRecalls,
  isCurrentSource,
  section = 'protection',
  notificationConversation,
  notificationRevision,
}: {
  onClose: () => void;
  /** 打开某个会话的撤回列表（由 MainView 渲染，复用聊天区气泡与筛选）。 */
  onOpenRecalls: (kind: 'c2c' | 'group', conv: string) => void;
  embedded?: boolean;
  recallDetails?: ReactNode;
  onCloseRecalls?: () => void;
  isCurrentSource?: () => boolean;
  section?: 'protection' | 'notifications';
  notificationConversation?: NotificationConversation;
  notificationRevision?: number;
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);
  const utils = trpc.useUtils();

  const [tab, setTab] = useState<Tab>('protect');
  const { panel: tabPanel, rememberScroll } = useTabPanelMotion(tab, true);
  const [editor, setEditor] = useState<Tab | null>(null);
  const active = useTabActive();
  const currentActivity = useRef(active);
  currentActivity.current = active;
  const locked = useAppLock((state) => state.locked);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const closeRecalls = useRef(onCloseRecalls);
  closeRecalls.current = onCloseRecalls;
  const directoryEntry = useRef<HTMLButtonElement | null>(null);
  const directoryRoot = useRef<HTMLDivElement | null>(null);
  const directoryScroll = useRef(0);
  const detailsRoot = useRef<HTMLDivElement | null>(null);
  const showingDetails = editor === 'records' && !!recallDetails;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      closeRecalls.current?.();
    };
  }, []);
  useEffect(() => {
    if (locked || !active) {
      epoch.current++;
      setEditor(null);
      closeRecalls.current?.();
    }
  }, [locked, active]);
  useEffect(() => {
    if (editor !== 'records') return;
    if (showingDetails)
      detailsRoot.current
        ?.querySelector<HTMLElement>('select, input, button, [tabindex]')
        ?.focus({ preventScroll: true });
    else {
      if (directoryRoot.current) directoryRoot.current.scrollTop = directoryScroll.current;
      directoryEntry.current?.focus({ preventScroll: true });
    }
  }, [editor, showingDetails]);
  const mutationGuard = () => {
    const started = epoch.current;
    return () =>
      mounted.current &&
      currentActivity.current &&
      epoch.current === started &&
      !useAppLock.getState().locked &&
      (isCurrentSource?.() ?? true);
  };

  const hasAccount = Boolean(useViewState((state) => state.openedUin));
  const status = trpc.settings.antiRecall.getStatus.useQuery(undefined, {
    enabled: active && !locked,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 3000,
  });
  const conversations = trpc.account.listConversationsWithCount.useQuery(undefined, {
    enabled: hasAccount && active && !locked && (!embedded || editor !== null),
    refetchOnWindowFocus: false,
  });
  // PC 快照静态账号的库 QQ 不会往里写 —— 触发器拦不到任何东西。
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: hasAccount && active && !locked,
    refetchOnWindowFocus: false,
  });
  const isStaticPcOnly = (config.data?.static ?? false) && !(config.data?.mobile ?? false);

  const setMethod = trpc.settings.antiRecall.setMethod.useMutation();
  const setScope = trpc.settings.antiRecall.setScope.useMutation();
  const setTargets = trpc.account.antiRecall.setTargets.useMutation();
  const setNotify = trpc.settings.antiRecall.setNotify.useMutation();
  const busy =
    setMethod.isLoading || setScope.isLoading || setTargets.isLoading || setNotify.isLoading;

  const scope: AntiRecallScope = status.data
    ? status.data.enabled
      ? status.data.mode
      : 'off'
    : 'off';
  const method: AntiRecallMethod = status.data?.enabled
    ? (status.data.method ?? 'database')
    : 'off';
  const mode: 'selected' | 'all' = status.data?.mode ?? 'selected';
  const consumedRequest = useRef<number | null>(null);
  useEffect(() => {
    if (
      section !== 'notifications' ||
      !notificationConversation ||
      !notificationRevision ||
      consumedRequest.current === notificationRevision ||
      !active ||
      locked ||
      !hasAccount ||
      !status.data ||
      !config.data ||
      !(isCurrentSource?.() ?? true)
    )
      return;
    consumedRequest.current = notificationRevision;
    setNotifySelected(
      new Set(status.data.notifyTargets.map((key) => key.slice(key.indexOf(':') + 1))),
    );
    setEditor('notify');
  }, [
    section,
    notificationConversation,
    notificationRevision,
    active,
    locked,
    hasAccount,
    status.data,
    config.data,
    isCurrentSource,
  ]);
  const qqRunning = status.data?.qqRunning ?? false;
  const installedCount = status.data?.installed.length ?? 0;
  const triggersReadOnly =
    status.data?.databaseReadOnly && (method === 'database' || installedCount > 0);

  /** 写操作的返回值（期望状态）直接落进查询缓存：点击即生效。 */
  function applyStatus(next: Awaited<ReturnType<typeof setScope.mutateAsync>>): void {
    if (!acceptSettingsReply(next)) {
      void status.refetch();
      return;
    }
    utils.settings.antiRecall.getStatus.setData(undefined, next);
    utils.account.antiRecall.getStatus.setData(undefined, next);
  }

  // 会话行（复用导出页视觉）。id 即触发器过滤值（uid / 群号）。
  const items = useMemo<PickItem[]>(() => {
    return ((conversations.data ?? []) as ConvWire[])
      .filter((c) => c.targetUid)
      .map((c) => {
        const kind = kindOf(c.chatType, c.targetUid);
        const count = Number(c.messageCount ?? 0);
        const dataline = isDataline(c.chatType);
        const name =
          c.targetDisplayName || (dataline ? datalineName(c.targetUid) : null) || c.targetUid;
        const label = kind === 'group' ? '群聊' : kind === 'dataline' ? '数据线' : '私聊';
        return {
          id: c.targetUid,
          name,
          avatarUrl: dataline
            ? deviceAvatarDataUri(c.targetUid)
            : convAvatarUrl(kind === 'group' ? 'group' : 'c2c', c.targetUid, c.targetUin),
          kind: kind === 'group' ? 'group' : 'c2c',
          uin: c.targetUin,
          total: count,
          meta: `${fmtCount(count)} 条 · ${label}`,
        };
      });
  }, [conversations.data]);

  // id → kind 映射：选择器只回传 id 集合，保存时据此还原每个会话的 kind。
  const kindById = useMemo(() => {
    const m = new Map<string, AntiRecallKind>();
    for (const target of status.data?.targets ?? []) m.set(target.id, target.kind);
    for (const key of status.data?.notifyTargets ?? []) {
      const [kind, ...parts] = key.split(':');
      if ((kind === 'c2c' || kind === 'group' || kind === 'dataline') && parts.length)
        m.set(parts.join(':'), kind);
    }
    for (const c of (conversations.data ?? []) as ConvWire[]) {
      if (c.targetUid) m.set(c.targetUid, kindOf(c.chatType, c.targetUid));
    }
    return m;
  }, [conversations.data, status.data?.targets, status.data?.notifyTargets]);

  // ── 保护 ────────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const t = status.data?.targets;
    if (t && (!embedded || editor !== 'protect')) {
      const next = new Set(t.map((target) => target.id));
      setSelected((current) => (sameIds(current, next) ? current : next));
    }
  }, [status.data?.targets, embedded, editor]);

  const savedIds = useMemo(
    () => new Set((status.data?.targets ?? []).map((t) => t.id)),
    [status.data?.targets],
  );
  const dirty = useMemo(() => !sameIds(selected, savedIds), [selected, savedIds]);

  async function onSetScope(next: AntiRecallScope): Promise<void> {
    if (next === scope) return;
    const current = mutationGuard();
    if (!current()) return;
    try {
      const res = await setScope.mutateAsync({ scope: next });
      if (!current()) return;
      applyStatus(res);
      void status.refetch();
    } catch (e) {
      if (!current()) return;
      void status.refetch();
      showError(next === 'off' ? '关闭防撤回失败' : '切换启用范围失败', errMsg(e));
    }
  }

  async function onSetMethod(next: AntiRecallMethod) {
    const current = mutationGuard();
    if (!current()) return;
    try {
      const result = await setMethod.mutateAsync({ method: next });
      if (!current()) return;
      applyStatus(result);
      void status.refetch();
    } catch (error) {
      if (current()) showError('切换防撤回方式失败', errMsg(error));
    }
  }

  function protectionStatusText(): string {
    if (!hasAccount) return '打开账号后生效。';
    if (isStaticPcOnly) return '当前来源为离线快照。';
    if (status.data?.error) return `应用失败：${status.data.error}`;
    if (status.data?.applying) return '正在应用保护规则…';
    if (method === 'off') return installedCount ? '正在卸下数据库触发器。' : '防撤回已关闭。';
    if (method === 'database') {
      if (!installedCount) return '尚未安装触发器。';
      return `已安装 ${installedCount} 张触发器。${qqRunning ? '改动可能需要重启 QQ 后生效。' : ''}`;
    }
    if (method === 'proxy')
      return status.data?.proxyConnected ? 'QQ 已连接代理。' : '等待 QQ 连接代理。';
    return status.data?.proxyConnected ? '正在通过代理留存原文。' : '正在通过数据库监听留存原文。';
  }

  const protectionControls = (
    <>
      <div className="weq-ar-protection-methods">
        <div className="weq-set-card-title">防撤回方式</div>
        <div className="weq-applock-methods" role="radiogroup" aria-label="防撤回方式">
          {METHODS.map((option) => (
            <button
              type="button"
              role="radio"
              key={option.value}
              value={option.value}
              aria-label={option.title}
              aria-checked={method === option.value}
              className={cn('weq-applock-method', method === option.value && 'is-active')}
              disabled={
                busy ||
                !status.data ||
                locked ||
                !active ||
                (status.data.databaseReadOnly && (triggersReadOnly || option.value === 'database'))
              }
              onClick={() => void onSetMethod(option.value)}
            >
              <span className="weq-applock-method-icon">
                <option.icon size={18} strokeWidth={1.8} aria-hidden />
              </span>
              <span className="weq-applock-method-main">
                <strong>{option.title}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      {(method === 'proxy' || method === 'weq') && (
        <Row
          label="连接本机 QQ"
          desc="在 QQ 登录页配置代理后重新登录。"
          control={<QqProxySettingsLink beforeNavigate={embedded ? undefined : onClose} />}
        />
      )}
      {method !== 'off' && (
        <Row
          label="保护范围"
          control={
            <SegmentedControl
              label="防撤回保护范围"
              value={mode}
              options={SCOPE_OPTIONS}
              disabled={busy || !status.data || triggersReadOnly}
              onChange={(scope) => void onSetScope(scope)}
            />
          }
        />
      )}
      <p className="weq-set-desc" role="status">
        {protectionStatusText()}
        {triggersReadOnly && ' 切换到可写档位后可修改数据库触发器。'}
      </p>
      {status.data?.restartSuggested && method !== 'database' && (
        <p className="weq-set-desc">已更新数据库触发器，QQ 可能需要重启后应用变化。</p>
      )}
    </>
  );

  async function onSaveTargets(): Promise<void> {
    const current = mutationGuard();
    if (!current()) return;
    const targets: Target[] = [...selected].map((id) => ({
      kind: kindById.get(id) ?? 'c2c',
      id,
    }));
    try {
      const result = await setTargets.mutateAsync({
        targets,
        expectedAccountUin: config.data?.uin,
        expectedAccountConfigId: config.data?.configId,
      });
      if (!current()) return;
      applyStatus(result);
      pushToast({ tone: 'success', title: '已保存受保护会话' });
    } catch (e) {
      if (!current()) return;
      void status.refetch();
      showError('保存失败', errMsg(e));
    }
  }

  // ── 通知 ────────────────────────────────────────────────────────────────
  const notifyIds = useMemo(
    () =>
      new Set(
        (status.data?.notifyTargets ?? []).map((k) => {
          const i = k.indexOf(':');
          return i >= 0 ? k.slice(i + 1) : k;
        }),
      ),
    [status.data?.notifyTargets],
  );
  const [notifySelected, setNotifySelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!embedded || editor !== 'notify')
      setNotifySelected((current) => (sameIds(current, notifyIds) ? current : new Set(notifyIds)));
  }, [notifyIds, embedded, editor]);

  const notifyDirty = useMemo(
    () => !sameIds(notifySelected, notifyIds),
    [notifySelected, notifyIds],
  );

  // 只有被保护的会话才可能记录下撤回 —— 按会话勾选模式下，通知列表也只列这些。
  const notifyItems = useMemo(
    () => (mode === 'all' ? items : items.filter((it) => savedIds.has(it.id))),
    [items, mode, savedIds],
  );

  async function onSaveNotify(): Promise<void> {
    const current = mutationGuard();
    if (!current()) return;
    const targets = [...notifySelected].map((id) => notifyKeyOf(kindById.get(id) ?? 'c2c', id));
    try {
      const result = await setNotify.mutateAsync({
        targets,
        expectedAccountUin: config.data?.uin,
        expectedAccountConfigId: config.data?.configId,
      });
      if (!current()) return;
      applyStatus(result);
      pushToast({ tone: 'success', title: '已保存通知会话' });
    } catch (e) {
      if (!current()) return;
      void status.refetch();
      showError('保存失败', errMsg(e));
    }
  }

  // ── 记录 ────────────────────────────────────────────────────────────────
  const summaries = trpc.account.antiRecall.listRecallConversations.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
    enabled:
      hasAccount &&
      active &&
      !locked &&
      (embedded ? editor === 'records' && !recallDetails : tab === 'records'),
  });

  const nameById = useMemo(() => {
    const m = new Map<string, PickItem>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  const recordRows = useMemo(() => {
    const rows = (summaries.data ?? []).filter((s) => s.conv);
    return [...rows].sort((a, b) => b.lastTs - a.lastTs);
  }, [summaries.data]);

  function openRecords(kind: AntiRecallKind, conv: string): void {
    if (!embedded) onClose();
    onOpenRecalls(kind === 'group' ? 'group' : 'c2c', conv);
  }

  const recordsContent = (
    <div className="weq-ar-records">
      {summaries.error ? (
        <QueryError
          message={summaries.error.message}
          retryLabel="重试读取撤回目录"
          retrying={summaries.isFetching}
          onRetry={() => void summaries.refetch()}
        />
      ) : summaries.isLoading ? (
        <div className="weq-ar-empty" role="status">
          <LoadingIndicator />
        </div>
      ) : recordRows.length === 0 ? (
        <div className="weq-ar-empty">
          <RotateCcw size={26} />
          <span>还没有撤回记录</span>
          <small>开启防撤回后，被撤回的消息会保留在原位，并在这里按会话汇总。</small>
        </div>
      ) : (
        recordRows.map((row) => {
          const meta = nameById.get(row.conv);
          const name = meta?.name ?? row.conv;
          const isGroup = row.kind === 'group';
          return (
            <button
              key={`${row.kind}:${row.conv}`}
              type="button"
              className="weq-ar-record"
              onClick={(event) => {
                directoryEntry.current = event.currentTarget;
                openRecords(row.kind, row.conv);
              }}
            >
              <Avatar
                name={name}
                avatarUrl={
                  meta?.avatarUrl ?? convAvatarUrl(isGroup ? 'group' : 'c2c', row.conv, meta?.uin)
                }
                seed={row.conv}
              />
              <span className="weq-ar-record-meta">
                <strong title={name}>{name}</strong>
                <small>
                  <span className="weq-number weq-number-inherit">{fmtCount(row.count)}</span> 条 ·{' '}
                  {formatWhen(row.lastTs) || (isGroup ? '群聊' : '私聊')}
                </small>
              </span>
              <ChevronRight size={16} />
            </button>
          );
        })
      )}
    </div>
  );

  if (embedded) {
    const unavailable = !status.data || (hasAccount && !config.data) || busy || locked || !active;
    const openEditor = (next: Tab) => {
      if (unavailable || !(isCurrentSource?.() ?? true)) return;
      epoch.current++;
      directoryEntry.current = null;
      directoryScroll.current = 0;
      setSelected(new Set(savedIds));
      setNotifySelected(new Set(notifyIds));
      setEditor(next);
    };
    const closeEditor = () => {
      epoch.current++;
      setEditor(null);
      onCloseRecalls?.();
    };
    const choosingProtection = editor === 'protect';
    const draft = choosingProtection
      ? dirty
        ? [...selected].sort()
        : null
      : editor === 'notify' && notifyDirty
        ? [...notifySelected].sort()
        : null;
    const title =
      editor === 'records' ? '撤回记录' : choosingProtection ? '启用防撤回的会话' : '通知哪些会话';
    const Container = section === 'notifications' ? 'span' : 'section';
    return (
      <Container
        className={
          section === 'notifications' ? 'weq-notification-scope-trigger' : 'weq-set weq-ar-settings'
        }
        aria-label={section === 'notifications' ? '撤回提醒设置' : '防撤回设置'}
        data-setting-id={section === 'notifications' ? undefined : 'anti-recall'}
      >
        {section === 'notifications' && (
          <button
            type="button"
            className="weq-set-iconbtn"
            title="选择提醒会话"
            aria-label="撤回提醒：选择提醒会话"
            disabled={unavailable || !hasAccount}
            onClick={() => openEditor('notify')}
          >
            <SlidersHorizontal size={14} aria-hidden />
          </button>
        )}
        {section === 'protection' && (
          <Card
            title="防撤回"
            resetId="recall-scope"
            icon={<ShieldCheck size={15} strokeWidth={1.8} />}
            action={<SettingsScopeBadge />}
          >
            {status.error ? (
              <QueryError
                message={status.error.message}
                retryLabel="重试读取防撤回状态"
                retrying={status.isFetching}
                onRetry={() => void status.refetch()}
              />
            ) : null}
            {config.error ? (
              <QueryError
                message={config.error.message}
                retryLabel="重试读取账号状态"
                retrying={config.isFetching}
                onRetry={() => void config.refetch()}
              />
            ) : null}
            {section === 'protection' && (
              <>
                {protectionControls}
                {scope === 'selected' ? (
                  <Row
                    label="启用防撤回的会话"
                    desc={
                      !hasAccount ? (
                        '打开账号后选择会话。'
                      ) : (
                        <NumericText>{`当前账号已选择 ${savedIds.size} 个会话。`}</NumericText>
                      )
                    }
                    control={
                      <button
                        type="button"
                        className="weq-set-btn"
                        disabled={unavailable || !hasAccount || isStaticPcOnly || triggersReadOnly}
                        aria-label="编辑启用防撤回的会话"
                        onClick={() => openEditor('protect')}
                      >
                        <Pencil size={14} aria-hidden="true" />
                        编辑会话
                      </button>
                    }
                  />
                ) : null}
                <Row label="撤回提醒" control={<NotificationMethodSelect event="recall" />} />
                <Row
                  label="提醒范围"
                  desc={
                    !hasAccount ? (
                      '打开账号后选择会话。'
                    ) : status.data ? (
                      notifyIds.size ? (
                        <NumericText>{`当前账号已选择 ${notifyIds.size} 个提醒会话。`}</NumericText>
                      ) : (
                        '未选择会话时不会发送撤回提醒。'
                      )
                    ) : undefined
                  }
                  control={
                    <button
                      type="button"
                      className="weq-set-btn"
                      disabled={unavailable || !hasAccount}
                      onClick={() => openEditor('notify')}
                    >
                      <Pencil size={14} aria-hidden />
                      选择提醒会话
                    </button>
                  }
                />
              </>
            )}
            {section === 'protection' && (
              <Row
                label="撤回记录"
                desc="按会话查看已保留的撤回消息。"
                control={
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={unavailable || !hasAccount}
                    onClick={() => openEditor('records')}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    查看撤回记录
                  </button>
                }
              />
            )}
          </Card>
        )}
        {editor && active && !locked ? (
          <ToolSurface
            key={editor}
            title={title}
            presentation="modal"
            draft={draft}
            busy={busy}
            onClose={closeEditor}
          >
            {(requestClose) => (
              <div className="weq-ar-tool">
                <PageShell
                  title={title}
                  onClose={requestClose}
                  leading={
                    editor === 'records' && recallDetails ? (
                      <button
                        type="button"
                        className="weq-set-iconbtn"
                        title="返回会话目录"
                        aria-label="返回会话目录"
                        onClick={onCloseRecalls}
                      >
                        <ArrowLeft size={18} />
                      </button>
                    ) : undefined
                  }
                  actions={
                    editor !== 'records' ? (
                      <button
                        className="weq-set-btn weq-set-btn-primary"
                        type="button"
                        disabled={busy || conversations.isLoading || !!conversations.error}
                        onClick={() => void (choosingProtection ? onSaveTargets() : onSaveNotify())}
                      >
                        <Save size={14} aria-hidden="true" />
                        保存选择
                      </button>
                    ) : undefined
                  }
                >
                  <div className={`weq-ar-tool-body${editor === 'records' ? ' is-records' : ''}`}>
                    {editor === 'records' ? (
                      <>
                        <div
                          className="weq-ar-directory"
                          ref={directoryRoot}
                          hidden={showingDetails}
                          onScroll={(event) => {
                            if (!showingDetails)
                              directoryScroll.current = event.currentTarget.scrollTop;
                          }}
                        >
                          {recordsContent}
                        </div>
                        {showingDetails ? (
                          <div className="weq-ar-details" ref={detailsRoot}>
                            {recallDetails}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <>
                        {conversations.error ? (
                          <QueryError
                            message={conversations.error.message}
                            retryLabel="重试读取会话"
                            retrying={conversations.isFetching}
                            onRetry={() => void conversations.refetch()}
                          />
                        ) : null}
                        <fieldset disabled={busy} className="weq-ar-picker">
                          <ConversationPicker
                            initialQuery={
                              editor === 'notify' ? notificationConversation?.conv : undefined
                            }
                            items={choosingProtection ? items : notifyItems}
                            loading={conversations.isLoading}
                            selected={choosingProtection ? selected : notifySelected}
                            onChange={choosingProtection ? setSelected : setNotifySelected}
                            emptyText={
                              choosingProtection
                                ? '暂无可保护的会话'
                                : mode === 'selected'
                                  ? '还没有启用防撤回的会话'
                                  : '暂无可通知的会话'
                            }
                          />
                        </fieldset>
                      </>
                    )}
                  </div>
                </PageShell>
              </div>
            )}
          </ToolSurface>
        ) : null}
      </Container>
    );
  }

  const content = (
    <section
      className={cn('group-keyword-dialog', 'weq-ar-dialog', embedded && 'is-embedded')}
      role={embedded ? 'region' : 'dialog'}
      aria-label={embedded ? '防撤回设置' : undefined}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header>
        <div className="group-keyword-title">
          <span className="group-keyword-title-icon">
            <ShieldCheck size={17} />
          </span>
          <div>
            <div className="weq-settings-title-with-scope">
              <strong>防撤回</strong>
              {embedded ? <SettingsScopeBadge /> : null}
            </div>
            <span>撤回的记录留在这里，不向对方发送任何内容</span>
          </div>
        </div>
        {!embedded ? (
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        ) : null}
      </header>

      <div className="weq-ar-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cn('weq-ar-tab', tab === t.id && 'is-on')}
            onClick={() => {
              if (t.id === tab) return;
              rememberScroll();
              setTab(t.id);
            }}
          >
            <t.icon size={15} />
            {t.label}
          </button>
        ))}
      </div>

      <div ref={tabPanel} className="group-keyword-body weq-ar-body">
        {tab === 'protect' ? (
          <>
            <Card title="保护规则" icon={<ListFilter size={15} strokeWidth={1.8} />}>
              {protectionControls}
            </Card>

            {scope === 'selected' ? (
              <Card
                title="启用防撤回的会话"
                icon={<MessagesSquare size={15} strokeWidth={1.8} />}
                action={
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-primary weq-set-btn-sm"
                    disabled={busy || status.isLoading || !status.data}
                    onClick={() => void onSaveTargets()}
                  >
                    <Save size={14} aria-hidden="true" />
                    {dirty ? '保存选择' : '已保存'}
                  </button>
                }
              >
                <div className="weq-set-picker">
                  <ConversationPicker
                    items={items}
                    loading={conversations.isLoading}
                    selected={selected}
                    onChange={setSelected}
                    emptyText="暂无可保护的会话"
                  />
                </div>
              </Card>
            ) : null}
          </>
        ) : null}

        {tab === 'notify' ? (
          <>
            <Row label="撤回提醒" control={<NotificationMethodSelect event="recall" />} />
            <Row
              label="提醒范围"
              control={
                <NotificationSettingsLink settingId="recall-notifications" onNavigate={onClose}>
                  选择提醒会话
                </NotificationSettingsLink>
              }
            />
          </>
        ) : null}

        {tab === 'records' ? recordsContent : null}
      </div>

      {!embedded ? (
        <footer className="group-keyword-foot">
          <span className="group-keyword-save-state" />
          <button type="button" className="group-keyword-done" onClick={onClose}>
            完成
          </button>
        </footer>
      ) : null}
    </section>
  );
  return embedded ? (
    content
  ) : (
    <OverlayLayer
      presentation="panel"
      className="modal-scrim group-keyword-scrim"
      onClose={onClose}
    >
      {content}
    </OverlayLayer>
  );
}
