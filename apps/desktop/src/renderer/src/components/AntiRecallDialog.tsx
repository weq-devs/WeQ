/**
 * 防撤回面板 —— 「更多 → 防撤回」打开。
 *
 * 三页：
 *   • 保护：总开关、保护范围（按会话勾选 / 永久全选）、受保护会话选择。
 *   • 通知：撤回通知总开关 + 按会话通知集。通知由主进程发系统原生通知，点通知
 *     会唤起窗口并跳到那条消息。
 *   • 记录：有撤回记录的会话目录（计数 + 最近一次撤回时间）。点一行打开该会话的
 *     撤回列表（聊天区同一套气泡与筛选），所以这里只做目录，不重复渲染消息。
 *
 * 全部读写走 account.antiRecall router。写操作是**乐观**的：服务层落配置后立刻返回
 * 期望状态（触发器重建在后台跑），这里把返回值直接写进查询缓存 —— 点击即生效，不卡 UI，
 * 也不需要 QQ 在线。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { BellRing, ChevronRight, RotateCcw, ShieldCheck, X } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useDialog } from './Dialog';
import { useToast } from './Toast';
import { Card, Row, Toggle } from './settings/controls';
import { ConversationPicker } from '../views/export/ConversationPicker';
import { convAvatarUrl, fmtCount, type PickItem } from '../views/export/types';
import { isDataline, deviceAvatarDataUri } from '../lib/deviceAvatar';
import { classifyChatType, datalineName } from '@weq/codec';
import { Avatar } from '../im-template/template/primitives';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import { cn } from '../im-template/template/classNames';

/** 触发器过滤所用的会话类型（与后端 AntiRecallKind 对齐）。 */
type AntiRecallKind = 'c2c' | 'group' | 'dataline';

/** 保护模式：按会话勾选 / 永久全选（不做会话筛选）。 */
type AntiRecallMode = 'selected' | 'all';

type Tab = 'protect' | 'notify' | 'records';

const TABS: { id: Tab; label: string; icon: typeof ShieldCheck }[] = [
  { id: 'protect', label: '保护', icon: ShieldCheck },
  { id: 'notify', label: '通知', icon: BellRing },
  { id: 'records', label: '记录', icon: RotateCcw },
];

const MODE_OPTIONS: { value: AntiRecallMode; label: string }[] = [
  { value: 'selected', label: '按会话勾选' },
  { value: 'all', label: '永久全选' },
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

/** 时间戳（unix 秒）→ 「今天 12:30」/「8/12 12:30」。 */
function formatWhen(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? `今天 ${time}` : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

export function AntiRecallDialog({
  onClose,
  onOpenRecalls,
}: {
  onClose: () => void;
  /** 打开某个会话的撤回列表（由 MainView 渲染，复用聊天区气泡与筛选）。 */
  onOpenRecalls: (kind: 'c2c' | 'group', conv: string) => void;
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);
  const utils = trpc.useUtils();

  const [tab, setTab] = useState<Tab>('protect');

  const status = trpc.account.antiRecall.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const conversations = trpc.account.listConversationsWithCount.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  // PC 快照静态账号的库 QQ 不会往里写 —— 触发器拦不到任何东西。
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const isStaticPcOnly = (config.data?.static ?? false) && !(config.data?.mobile ?? false);

  const setEnabled = trpc.account.antiRecall.setEnabled.useMutation();
  const setMode = trpc.account.antiRecall.setMode.useMutation();
  const setTargets = trpc.account.antiRecall.setTargets.useMutation();
  const setNotify = trpc.account.antiRecall.setNotify.useMutation();
  const busy =
    setEnabled.isLoading || setMode.isLoading || setTargets.isLoading || setNotify.isLoading;

  const enabled = status.data?.enabled ?? false;
  const mode: AntiRecallMode = status.data?.mode ?? 'selected';
  const notifyEnabled = status.data?.notifyEnabled ?? false;
  const qqRunning = status.data?.qqRunning ?? false;
  const installedCount = status.data?.installed.length ?? 0;

  useEscapeToClose(onClose);

  /** 写操作的返回值（期望状态）直接落进查询缓存：点击即生效。 */
  function applyStatus(next: Awaited<ReturnType<typeof setEnabled.mutateAsync>>): void {
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
    for (const c of (conversations.data ?? []) as ConvWire[]) {
      if (c.targetUid) m.set(c.targetUid, kindOf(c.chatType, c.targetUid));
    }
    return m;
  }, [conversations.data]);

  // ── 保护 ────────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const t = status.data?.targets;
    if (t) setSelected(new Set(t.map((x) => x.id)));
  }, [status.data?.targets]);

  const savedIds = useMemo(
    () => new Set((status.data?.targets ?? []).map((t) => t.id)),
    [status.data?.targets],
  );
  const dirty = useMemo(() => {
    if (selected.size !== savedIds.size) return true;
    for (const id of selected) if (!savedIds.has(id)) return true;
    return false;
  }, [selected, savedIds]);

  async function onToggleEnabled(next: boolean): Promise<void> {
    try {
      const res = await setEnabled.mutateAsync({ enabled: next });
      applyStatus(res);
      pushToast({
        tone: next ? 'success' : 'info',
        title: next ? '防撤回已开启' : '防撤回已关闭',
        message: next
          ? res.qqRunning
            ? '触发器已装上。QQ 正在运行，可能要重启 QQ 才真正生效。'
            : '触发器已装上。'
          : res.qqRunning
            ? '触发器已卸下。QQ 正在运行，可能要重启 QQ 才彻底停止。'
            : '触发器已卸下。',
      });
    } catch (e) {
      void status.refetch();
      showError(next ? '开启防撤回失败' : '关闭防撤回失败', errMsg(e));
    }
  }

  async function onSetMode(next: AntiRecallMode): Promise<void> {
    if (next === mode) return;
    try {
      applyStatus(await setMode.mutateAsync({ mode: next }));
    } catch (e) {
      void status.refetch();
      showError('切换保护范围失败', errMsg(e));
    }
  }

  async function onSaveTargets(): Promise<void> {
    const targets: Target[] = [...selected].map((id) => ({
      kind: kindById.get(id) ?? 'c2c',
      id,
    }));
    try {
      applyStatus(await setTargets.mutateAsync({ targets }));
      pushToast({ tone: 'success', title: '已保存受保护会话' });
    } catch (e) {
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
    setNotifySelected(new Set(notifyIds));
  }, [notifyIds]);

  const notifyDirty = useMemo(() => {
    if (notifySelected.size !== notifyIds.size) return true;
    for (const id of notifySelected) if (!notifyIds.has(id)) return true;
    return false;
  }, [notifySelected, notifyIds]);

  // 只有被保护的会话才可能记录下撤回 —— 按会话勾选模式下，通知列表也只列这些。
  const notifyItems = useMemo(
    () => (mode === 'all' ? items : items.filter((it) => savedIds.has(it.id))),
    [items, mode, savedIds],
  );

  async function onToggleNotify(next: boolean): Promise<void> {
    try {
      applyStatus(await setNotify.mutateAsync({ enabled: next }));
    } catch (e) {
      void status.refetch();
      showError('通知设置失败', errMsg(e));
    }
  }

  async function onSaveNotify(): Promise<void> {
    const targets = [...notifySelected].map((id) => notifyKeyOf(kindById.get(id) ?? 'c2c', id));
    try {
      applyStatus(await setNotify.mutateAsync({ targets }));
      pushToast({ tone: 'success', title: '已保存通知会话' });
    } catch (e) {
      void status.refetch();
      showError('保存失败', errMsg(e));
    }
  }

  // ── 记录 ────────────────────────────────────────────────────────────────
  const summaries = trpc.account.antiRecall.listRecallConversations.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: tab === 'records',
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
    onClose();
    onOpenRecalls(kind === 'group' ? 'group' : 'c2c', conv);
  }

  return (
    <div
      className="modal-scrim group-keyword-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className={cn('group-keyword-dialog', 'weq-ar-dialog')}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div className="group-keyword-title">
            <span className="group-keyword-title-icon">
              <ShieldCheck size={17} />
            </span>
            <div>
              <strong>防撤回</strong>
              <span>撤回的记录留在这里，不向对方发送任何内容</span>
            </div>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="weq-ar-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={cn('weq-ar-tab', tab === t.id && 'is-on')}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="group-keyword-body weq-ar-body">
          {tab === 'protect' ? (
            <>
              <Card title="服务开关">
                <Row
                  label="启用防撤回"
                  desc={
                    isStaticPcOnly
                      ? '静态账号的数据库是导入的离线快照，QQ 不会往里写入，触发器拦不到任何撤回。'
                      : '在本地数据库上拦下撤回写入，仅影响本机记录。'
                  }
                  control={
                    <Toggle
                      checked={enabled && !isStaticPcOnly}
                      disabled={busy || status.isLoading || isStaticPcOnly}
                      onChange={(next) => void onToggleEnabled(next)}
                      label="启用防撤回"
                    />
                  }
                />
                <Row
                  label="保护范围"
                  desc={
                    mode === 'all'
                      ? '不做会话筛选：所有会话（含以后新增的）都受保护。'
                      : '只保护下面勾选的会话。'
                  }
                  control={
                    <div className="weq-set-seg" role="radiogroup" aria-label="防撤回保护范围">
                      {MODE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={mode === opt.value}
                          className={cn('weq-set-seg-item', mode === opt.value && 'is-on')}
                          disabled={busy || status.isLoading}
                          onClick={() => void onSetMode(opt.value)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  }
                />
                <Row
                  label={
                    <span className="weq-set-mcp-state">
                      <span
                        className={cn('weq-set-mcp-dot', installedCount > 0 && 'is-on')}
                        aria-hidden
                      />
                      {installedCount > 0 ? `已安装（${installedCount} 张触发器）` : '未安装'}
                    </span>
                  }
                  desc={
                    qqRunning
                      ? 'QQ 正在运行：随时可改，但可能要重启 QQ 才真正生效。'
                      : 'QQ 下次启动会加载最新拦截规则。'
                  }
                  control={<span />}
                />
              </Card>

              {mode === 'selected' ? (
                <Card
                  title="受保护的会话"
                  action={
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-sm"
                      disabled={busy || !dirty}
                      onClick={() => void onSaveTargets()}
                    >
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
              <Card title="撤回通知">
                <Row
                  label="撤回时通知我"
                  desc="对方撤回被拦下时弹系统通知，点通知直接跳到那条消息。"
                  control={
                    <Toggle
                      checked={notifyEnabled}
                      disabled={busy || !enabled}
                      onChange={(next) => void onToggleNotify(next)}
                      label="撤回时通知我"
                    />
                  }
                />
                {!enabled ? (
                  <p className="weq-set-note">先开启防撤回 —— 没有拦下的撤回就没有记录可通知。</p>
                ) : null}
              </Card>

              {notifyEnabled ? (
                <Card
                  title="通知哪些会话"
                  action={
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-sm"
                      disabled={busy || !notifyDirty}
                      onClick={() => void onSaveNotify()}
                    >
                      {notifyDirty ? '保存选择' : '已保存'}
                    </button>
                  }
                >
                  <div className="weq-set-picker">
                    <ConversationPicker
                      items={notifyItems}
                      loading={conversations.isLoading}
                      selected={notifySelected}
                      onChange={setNotifySelected}
                      emptyText={mode === 'selected' ? '还没有受保护的会话' : '暂无可通知的会话'}
                    />
                  </div>
                </Card>
              ) : null}
            </>
          ) : null}

          {tab === 'records' ? (
            <div className="weq-ar-records">
              {summaries.isLoading ? (
                <div className="weq-ar-empty">加载中…</div>
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
                  const avatarUrl =
                    meta?.avatarUrl ??
                    convAvatarUrl(isGroup ? 'group' : 'c2c', row.conv, meta?.uin);
                  return (
                    <button
                      key={`${row.kind}:${row.conv}`}
                      type="button"
                      className="weq-ar-record"
                      onClick={() => openRecords(row.kind, row.conv)}
                    >
                      <Avatar name={name} avatarUrl={avatarUrl} seed={row.conv} />
                      <span className="weq-ar-record-meta">
                        <strong title={name}>{name}</strong>
                        <small>
                          {fmtCount(row.count)} 条 ·{' '}
                          {formatWhen(row.lastTs) || (isGroup ? '群聊' : '私聊')}
                        </small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
        </div>

        <footer className="group-keyword-foot">
          <span className="group-keyword-save-state" />
          <button type="button" className="group-keyword-done" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}
