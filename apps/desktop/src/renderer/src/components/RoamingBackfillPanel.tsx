import { useEffect, useMemo, useState } from 'react';
import {
  CalendarRange,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleSlash,
  Clock3,
  CloudDownload,
  FlipHorizontal2,
  History,
  Info,
  Layers,
  ListFilter,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Square,
  Trash2,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { classifyChatType } from '@weq/codec';
import type { RoamingTarget } from '@weq/service';
import { trpc } from '../trpc/client';
import { useQQAutoRefresh } from '../hooks/useQQAutoRefresh';
import { useDialog } from './Dialog';
import { WindowedList } from './WindowedList';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { MessageCalendar } from './MessageCalendar';
import { Avatar } from '../views/export/widgets';
import { convAvatarUrl } from '../views/export/types';
import { beijingDay, daySeconds, pickCalendarRange } from '../lib/messageCalendar';
import '../styles/roaming-backfill.css';

const targetKey = (target: RoamingTarget) => `${target.kind}:${target.conv}`;
const addressable = (target: RoamingTarget) =>
  target.kind === 'group'
    ? /^[1-9]\d*$/.test(target.conv) && Number.isSafeInteger(Number(target.conv))
    : /^u_[A-Za-z0-9_-]{1,125}$/.test(target.conv);
const format = (n: number) => n.toLocaleString('zh-CN');
const labels = {
  planned: '待开始',
  running: '运行中',
  pausing: '暂停收尾中',
  paused: '已暂停',
  partial: '本轮结束，仍有缺口',
  completed: '候选缺口已覆盖',
  cancelled: '已取消',
  failed: '遇到错误',
};
const jobGlyph = {
  planned: Clock3,
  running: Loader2,
  pausing: Loader2,
  paused: CirclePause,
  partial: CircleAlert,
  completed: CircleCheck,
  cancelled: CircleSlash,
  failed: CircleAlert,
} as const;
const atBeijing = (at: number) =>
  new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const dayBefore = (days: number) => beijingDay(new Date(Date.now() - days * 86_400_000));

/** 快捷区间：0 = 不限；其余按北京时间「含今天」往前推。 */
const RANGE_PRESETS = [
  { label: '不限', days: 0 },
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
  { label: '近一年', days: 365 },
] as const;

export function RoamingBackfillPanel({
  initialTarget,
  initialTargets = [],
  surface = 'all',
  targetMode = 'select',
  taskId,
}: {
  initialTarget?: RoamingTarget;
  initialTargets?: RoamingTarget[];
  surface?: 'all' | 'tasks';
  targetMode?: 'select' | 'fixed';
  /** 统一任务列表仅展开选中任务，沿用原有续作、回执与覆盖口径。 */
  taskId?: string;
}) {
  const utils = trpc.useUtils();
  const confirm = useDialog((s) => s.confirm);
  const [fixedTargets] = useState(() => [
    ...new Map(
      [...initialTargets, ...(initialTarget ? [initialTarget] : [])].map((target) => [
        targetKey(target),
        { ...target },
      ]),
    ).values(),
  ]);
  const [editingTargets, setEditingTargets] = useState(false);
  const fixed = targetMode === 'fixed' && !editingTargets;
  const singleTarget = fixedTargets.length === 1 ? fixedTargets[0] : undefined;
  const invalidFixedTargets =
    fixed && (!fixedTargets.length || fixedTargets.some((target) => !addressable(target)));
  const [selected, setSelected] = useState<Set<string>>(
    new Set(
      [...initialTargets, ...(initialTarget ? [initialTarget] : [])]
        .filter(addressable)
        .map(targetKey),
    ),
  );
  const [query, setQuery] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [beforeOldest, setBeforeOldest] = useState(false);
  const [intervalMs, setIntervalMs] = useState(500);
  const [error, setError] = useState<string | null>(null);
  const autoRefresh = useQQAutoRefresh(true);
  const state = trpc.account.roamingBackfill.list.useQuery(undefined, {
    ...autoRefresh,
    refetchInterval: autoRefresh.enabled ? 1000 : false,
  });
  const contacts = trpc.account.listConversationsWithCount.useQuery(undefined, {
    ...autoRefresh,
    enabled: autoRefresh.enabled && surface !== 'tasks' && !fixed,
  });
  const refresh = () => {
    void utils.account.roamingBackfill.list.invalidate();
  };
  const onError = (e: { message: string }) => setError(e.message);
  const staleBackend = Boolean(state.data && state.data.historyVersion !== 2);
  const plan = trpc.account.roamingBackfill.plan.useMutation({
    onSuccess: () => {
      refresh();
    },
    onError,
  });
  const run = trpc.account.roamingBackfill.start.useMutation({ onSuccess: refresh, onError });
  const pause = trpc.account.roamingBackfill.pause.useMutation({ onSuccess: refresh, onError });
  const cancel = trpc.account.roamingBackfill.cancel.useMutation({ onSuccess: refresh, onError });
  const remove = trpc.account.roamingBackfill.remove.useMutation({ onSuccess: refresh, onError });
  const busy = Boolean(state.data?.activeId || state.data?.scanning);
  const mutating =
    plan.isLoading || run.isLoading || pause.isLoading || cancel.isLoading || remove.isLoading;
  const targetInfo = useMemo(() => {
    const map = new Map<string, { uin: string; messageCount: number }>();
    if (fixed) return map;
    for (const row of contacts.data ?? []) {
      const category = classifyChatType(row.chatType);
      if (category !== 'group' && category !== 'direct') continue;
      const kind = category === 'group' ? 'group' : 'c2c';
      if (!row.targetUid || (kind === 'c2c' && !row.targetUid.startsWith('u_'))) continue;
      map.set(`${kind}:${row.targetUid}`, {
        uin: row.targetUin,
        messageCount: row.messageCount,
      });
    }
    return map;
  }, [contacts.data, fixed]);
  const targets = useMemo(() => {
    if (fixed) return fixedTargets;
    const map = new Map<string, RoamingTarget>();
    for (const row of contacts.data ?? []) {
      const category = classifyChatType(row.chatType);
      if (category !== 'group' && category !== 'direct') continue;
      const kind = category === 'group' ? 'group' : 'c2c';
      if (!row.targetUid || (kind === 'c2c' && !row.targetUid.startsWith('u_'))) continue;
      const target: RoamingTarget = {
        kind,
        conv: row.targetUid,
        name: row.targetRemark || row.targetDisplayName || row.senderNick || row.targetUid,
      };
      if (addressable(target)) map.set(targetKey(target), target);
    }
    for (const target of fixedTargets) if (addressable(target)) map.set(targetKey(target), target);
    return [...map.values()];
  }, [contacts.data, fixed, fixedTargets]);
  const initialKey = initialTarget && addressable(initialTarget) ? targetKey(initialTarget) : null;
  useEffect(() => {
    if (fixed || !initialKey) return;
    setSelected((current) =>
      current.has(initialKey) ? current : new Set([...current, initialKey]),
    );
  }, [fixed, initialKey]);
  const jobs = (state.data?.jobs ?? []).filter((job) => !taskId || job.id === taskId);
  const visible = useMemo(
    () =>
      targets.filter((target) =>
        `${target.name} ${target.conv}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [targets, query],
  );
  const targetNames = useMemo(
    () => new Map(targets.map((target) => [targetKey(target), target.name])),
    [targets],
  );
  const multi = useMultiSelection({
    ids: visible.map(targetKey),
    selected,
    onChange: setSelected,
    disabled: plan.isLoading || fixed || surface === 'tasks',
    enabled: !fixed && surface !== 'tasks',
  });
  const probeUids = useMemo(
    () =>
      [
        ...new Set(
          targets
            .filter((target) => target.kind === 'c2c' && !targetInfo.get(targetKey(target))?.uin)
            .map((target) => target.conv),
        ),
      ].slice(0, 200),
    [targets, targetInfo],
  );
  // 固定范围没有会话列表可比对，按 uid 补一次资料，才能拼出真人头像而不是首字兜底。
  const profiles = trpc.account.getProfilesByUids.useQuery(
    { uids: probeUids },
    { enabled: probeUids.length > 0, staleTime: 300_000, refetchOnWindowFocus: false },
  );
  const uinByUid = useMemo(
    () => new Map((profiles.data ?? []).map((profile) => [profile.uid, profile.uin])),
    [profiles.data],
  );
  const calendarTargets = useMemo(
    () =>
      (fixed ? fixedTargets : targets.filter((target) => selected.has(targetKey(target)))).map(
        (target) => ({ kind: target.kind, conv: target.conv }),
      ),
    [fixed, fixedTargets, selected, targets],
  );
  const calendar = trpc.account.exportCalendar.useQuery(
    { targets: calendarTargets },
    {
      enabled: calendarTargets.length > 0,
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const activePreset = useMemo(() => {
    if (!start && !end) return 0;
    for (const preset of RANGE_PRESETS) {
      if (!preset.days) continue;
      if (start === dayBefore(preset.days - 1) && end === dayBefore(0)) return preset.days;
    }
    return -1;
  }, [start, end]);

  function pickPreset(days: number) {
    if (!days) {
      setStart('');
      setEnd('');
      return;
    }
    setStart(dayBefore(days - 1));
    setEnd(dayBefore(0));
  }

  function pickDay(day: string) {
    const range = pickCalendarRange(start, end, day);
    setStart(range.start);
    setEnd(range.end);
  }

  function scan() {
    if (invalidFixedTargets) return;
    setError(null);
    const range = {
      start: start ? daySeconds(start) : undefined,
      end: end ? daySeconds(end) + 86_399 : undefined,
    };
    plan.mutate({
      targets: fixed ? fixedTargets : targets.filter((target) => selected.has(targetKey(target))),
      range,
      beforeOldest,
      intervalMs,
      transport: 'sso',
    });
  }

  const avatarFor = (target: RoamingTarget) =>
    convAvatarUrl(
      target.kind,
      target.conv,
      targetInfo.get(targetKey(target))?.uin ?? uinByUid.get(target.conv),
    );

  return (
    <div className="weq-roaming-panel" {...multi.rootProps}>
      <div className="weq-roaming-body">
        <div className="weq-roaming-statusline">
          <span
            className={`weq-roaming-chip${state.data?.online ? ' is-online' : ' is-offline'}`}
            title={state.data?.online ? '在线拉取可用' : '离线时只扫描本地锚点与缓存'}
          >
            {state.data?.online ? <Radio size={13} /> : <WifiOff size={13} />}
            {state.data?.onlineAllowed === false
              ? '完全离线模式'
              : state.data
                ? state.data.online
                  ? 'QQ 在线'
                  : '离线 · 仅本地锚点'
                : '读取状态中'}
          </span>
          <span className="weq-roaming-chip is-quiet" title="每次请求最多 30 个 seq">
            <Layers size={13} />
            SSO · 30 seq/窗
          </span>
          {jobs.length ? (
            <span className="weq-roaming-chip is-quiet">
              <History size={13} />
              {jobs.length} 个任务
            </span>
          ) : null}
          <span className="weq-roaming-statusline-spacer" />
          <button
            type="button"
            className="weq-roaming-iconbtn"
            title="刷新任务状态"
            aria-label="刷新任务状态"
            onClick={refresh}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {staleBackend ? (
          <p role="alert" className="weq-roaming-notice is-error">
            <CircleAlert size={14} />
            当前后端不包含所选历史接口，请重启开发版 WeQ。
          </p>
        ) : null}
        {state.error || error ? (
          <p role="alert" className="weq-roaming-notice is-error">
            <CircleAlert size={14} />
            {error ?? state.error?.message}
          </p>
        ) : null}
        {!fixed && contacts.error ? (
          <p role="alert" className="weq-roaming-notice is-error">
            <CircleAlert size={14} />
            会话列表读取失败：{contacts.error.message}
          </p>
        ) : null}

        {surface !== 'tasks' ? (
          <div className={`weq-roaming-grid${fixed ? ' is-fixed' : ''}`}>
            {!fixed ? (
              <section className="weq-roaming-card weq-roaming-targets-card" aria-label="补全会话">
                <header className="weq-roaming-card-head">
                  <span className="weq-roaming-card-icon">
                    <Users size={16} />
                  </span>
                  <span className="weq-roaming-card-text">
                    <strong>选择会话</strong>
                    <small>
                      已选 {selected.size} / {targets.length}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="weq-roaming-ghostbtn"
                    title="全选筛选结果"
                    aria-label="全选当前筛选结果"
                    disabled={!visible.length}
                    onClick={() =>
                      setSelected((current) => new Set([...current, ...visible.map(targetKey)]))
                    }
                  >
                    <CheckCheck size={14} />
                    全选
                  </button>
                  <button
                    type="button"
                    className="weq-roaming-ghostbtn"
                    title="反选筛选结果"
                    aria-label="反选当前筛选结果"
                    disabled={!visible.length}
                    onClick={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const target of visible) {
                          const id = targetKey(target);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                        }
                        return next;
                      })
                    }
                  >
                    <FlipHorizontal2 size={14} />
                  </button>
                  <button
                    type="button"
                    className="weq-roaming-iconbtn"
                    title="清空选择"
                    aria-label="清空所选会话"
                    disabled={!selected.size}
                    onClick={() => setSelected(new Set())}
                  >
                    <X size={14} />
                  </button>
                </header>
                <div className="weq-roaming-search">
                  <Search size={14} aria-hidden />
                  <input
                    type="search"
                    aria-label="搜索补全会话"
                    placeholder="搜索会话名称或号码"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query ? (
                    <button
                      type="button"
                      className="weq-roaming-iconbtn"
                      title="清空搜索"
                      aria-label="清空搜索"
                      onClick={() => setQuery('')}
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                </div>
                <div className="weq-roaming-targets" aria-label="补全会话">
                  {contacts.isLoading ? (
                    <p className="weq-roaming-empty">
                      <Loader2 size={14} className="weq-roaming-spin" />
                      正在读取会话…
                    </p>
                  ) : visible.length === 0 ? (
                    <p className="weq-roaming-empty">
                      <Search size={14} />
                      没有匹配的可补全会话
                    </p>
                  ) : (
                    <WindowedList
                      items={visible}
                      rowHeight={58}
                      height={324}
                      itemKey={targetKey}
                      scrollToKey={multi.focusRequest?.id}
                      scrollRevision={multi.focusRequest?.revision}
                      renderItem={(target) => {
                        const id = targetKey(target);
                        const checked = selected.has(id);
                        const info = targetInfo.get(id);
                        return (
                          <label
                            key={id}
                            className={`weq-roaming-target${checked ? ' is-on' : ''}`}
                            {...multi.itemProps(id)}
                          >
                            <input type="checkbox" checked={checked} readOnly />
                            <Avatar url={avatarFor(target)} name={target.name} size={34} />
                            <span className="weq-roaming-target-text">
                              <strong title={target.name}>{target.name}</strong>
                              <small>
                                {target.kind === 'group' ? '群聊' : '私聊'} · {target.conv}
                                {info?.messageCount ? ` · ${format(info.messageCount)} 条` : ''}
                              </small>
                            </span>
                            <span className="weq-roaming-check" aria-hidden>
                              {checked ? <Check size={13} /> : null}
                            </span>
                          </label>
                        );
                      }}
                    />
                  )}
                </div>
              </section>
            ) : null}

            <section
              className={`weq-roaming-card weq-roaming-scope${fixed ? ' is-fixed' : ''}`}
              aria-label="补全范围"
            >
              <header className="weq-roaming-card-head">
                <span className="weq-roaming-card-icon">
                  <CalendarRange size={16} />
                </span>
                <span className="weq-roaming-card-text">
                  <strong>拉取范围</strong>
                  <small>北京时间 · 留空表示不限</small>
                </span>
                {fixed ? (
                  <button
                    type="button"
                    className="weq-roaming-ghostbtn"
                    aria-label="编辑列表"
                    disabled={plan.isLoading}
                    onClick={() => setEditingTargets(true)}
                  >
                    <ListFilter size={14} />
                    编辑列表
                  </button>
                ) : null}
              </header>
              {fixed ? (
                invalidFixedTargets ? (
                  <p role="alert" className="weq-roaming-notice is-error">
                    <CircleAlert size={14} />
                    所选会话包含不支持漫游拉取的对象，请返回会话列表重新选择。
                  </p>
                ) : singleTarget ? (
                  <div className="weq-roaming-fixed-target" aria-label="拉取目标">
                    <Avatar url={avatarFor(singleTarget)} name={singleTarget.name} size={40} />
                    <span>
                      <strong>{singleTarget.name}</strong>
                      <small>
                        {singleTarget.kind === 'group' ? <Users size={12} /> : <Radio size={12} />}
                        {singleTarget.kind === 'group' ? '群聊' : '私聊'} · {singleTarget.conv}
                      </small>
                    </span>
                  </div>
                ) : (
                  <details className="weq-roaming-fixed-targets">
                    <summary>
                      <Users size={14} />
                      已选 {fixedTargets.length} 个会话
                      <ChevronRight size={13} className="weq-roaming-disclosure" />
                    </summary>
                    <WindowedList
                      items={fixedTargets}
                      rowHeight={58}
                      height={232}
                      itemKey={targetKey}
                      renderItem={(target) => (
                        <div className="weq-roaming-fixed-target">
                          <Avatar url={avatarFor(target)} name={target.name} size={32} />
                          <span>
                            <strong>{target.name}</strong>
                            <small>
                              {target.kind === 'group' ? '群聊' : '私聊'} · {target.conv}
                            </small>
                          </span>
                        </div>
                      )}
                    />
                  </details>
                )
              ) : null}

              <div className="weq-roaming-scope-body">
                <div className="weq-roaming-scope-controls">
                  <div className="weq-roaming-presets" role="group" aria-label="快捷日期范围">
                    {RANGE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className={`weq-roaming-chipbtn${activePreset === preset.days ? ' is-on' : ''}`}
                        aria-pressed={activePreset === preset.days}
                        onClick={() => pickPreset(preset.days)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <div className="weq-roaming-range-summary">
                    <CalendarRange size={14} aria-hidden />
                    <span>{start || '不限起始'}</span>
                    <ChevronRight size={13} className="weq-roaming-range-arrow" aria-hidden />
                    <span>{end || '不限结束'}</span>
                    {start || end ? (
                      <button
                        type="button"
                        className="weq-roaming-linkbtn"
                        onClick={() => pickPreset(0)}
                      >
                        清除
                      </button>
                    ) : null}
                  </div>
                  <dl className="weq-roaming-overview">
                    <div>
                      <dt>目标会话</dt>
                      <dd>{fixed ? fixedTargets.length : selected.size} 个</dd>
                    </div>
                    <div>
                      <dt>时间范围</dt>
                      <dd>{start && end ? `${start} → ${end}` : start || end || '不限'}</dd>
                    </div>
                    <div>
                      <dt>请求方式</dt>
                      <dd>SSO · 每窗 30 seq</dd>
                    </div>
                  </dl>
                  <div className="weq-roaming-fields">
                    <label className="weq-roaming-field">
                      <span>
                        <Clock3 size={13} />
                        请求间隔
                      </span>
                      <span className="weq-roaming-field-input">
                        <input
                          type="number"
                          min={500}
                          max={60000}
                          step={100}
                          value={intervalMs}
                          onChange={(e) => setIntervalMs(Number(e.target.value))}
                        />
                        <small>毫秒</small>
                      </span>
                    </label>
                    <label className="weq-roaming-checkbox">
                      <input
                        type="checkbox"
                        checked={beforeOldest}
                        onChange={(e) => setBeforeOldest(e.target.checked)}
                      />
                      <span>
                        包含最早本地锚点之前的区间
                      </span>
                    </label>
                  </div>
                </div>
                <div className="weq-roaming-scope-calendar">
                  <MessageCalendar
                    days={calendar.data ?? []}
                    start={start}
                    end={end}
                    allowEmpty
                    onPick={pickDay}
                    loading={calendarTargets.length > 0 && calendar.isLoading}
                    busy={plan.isLoading}
                    error={calendar.error?.message}
                  />
                </div>
              </div>
              <footer className="weq-roaming-actions">
                <span className="weq-roaming-hint">
                  <Info size={13} />
                  无本地锚点的历史覆盖未知
                </span>
                <button
                  type="button"
                  className="weq-roaming-primary"
                  disabled={
                    (fixed ? invalidFixedTargets : !selected.size) ||
                    busy ||
                    mutating ||
                    !state.data ||
                    Boolean(state.error) ||
                    staleBackend
                  }
                  onClick={scan}
                >
                  {plan.isLoading || state.data?.scanning ? (
                    <Loader2 size={15} className="weq-roaming-spin" />
                  ) : (
                    <ScanSearch size={15} />
                  )}
                  {plan.isLoading || state.data?.scanning ? '扫描中…' : '扫描候选缺口'}
                </button>
              </footer>
            </section>
          </div>
        ) : null}

        <section className="weq-roaming-jobs" aria-label="补全任务">
          {!taskId ? (
            <header className="weq-roaming-card-head is-section">
              <span className="weq-roaming-card-icon">
                <CloudDownload size={16} />
              </span>
              <span className="weq-roaming-card-text">
                <strong>补全任务</strong>
                <small>
                  {jobs.length ? `${jobs.length} 个任务 · 最新在前` : '尚无批量补全任务'}
                </small>
              </span>
            </header>
          ) : null}
          {jobs.length ? (
            jobs.map((job) => {
              const covered = job.plannedSeqs - job.remainingSeqs;
              const pct =
                job.plannedSeqs > 0
                  ? Math.min(100, Math.max(0, (covered / job.plannedSeqs) * 100))
                  : 0;
              const JobGlyph = jobGlyph[job.status];
              return (
                <article key={job.id} className={`weq-roaming-job is-${job.status}`}>
                  <header className="weq-roaming-job-head">
                    <span className="weq-roaming-job-icon" aria-hidden>
                      <JobGlyph
                        size={16}
                        className={
                          job.status === 'running' || job.status === 'pausing'
                            ? 'weq-roaming-spin'
                            : undefined
                        }
                      />
                    </span>
                    <span className="weq-roaming-job-title">
                      <strong>{labels[job.status]}</strong>
                      <small>
                        <Clock3 size={12} />
                        {atBeijing(job.createdAt)}
                        <Users size={12} />
                        {job.targets.length} 个会话
                      </small>
                    </span>
                    <span className="weq-roaming-job-ratio" title="已覆盖候选 / 候选总数">
                      {format(covered)}
                      <small>/ {format(job.plannedSeqs)}</small>
                    </span>
                  </header>
                  <div
                    className="weq-roaming-progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(pct)}
                    aria-label="候选缺口覆盖进度"
                  >
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <div className="weq-roaming-job-targets">
                    {job.targets.map((target) => (
                      <span key={targetKey(target)} className="weq-roaming-tag">
                        {target.kind === 'group' ? <Users size={12} /> : <Radio size={12} />}
                        {target.name}
                      </span>
                    ))}
                  </div>
                  <dl className="weq-roaming-stats">
                    {(
                      [
                        ['候选 seq', job.plannedSeqs],
                        ['已覆盖', covered],
                        ['仍未确认', job.remainingSeqs],
                        ['尚待检查', job.pendingSeqs],
                        ['在线请求', job.requests],
                        ['缓存窗口', job.cacheWindows],
                        ['失败', job.errors],
                        ['空响应', job.unparsedOrEmpty],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{format(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  {job.note ? (
                    <p className="weq-roaming-note">
                      <Info size={13} />
                      <span>{job.note}</span>
                    </p>
                  ) : null}
                  {job.options.transport === 'native500' || job.options.transport === 'sso500' ? (
                    <p role="alert" className="weq-roaming-notice is-error">
                      <CircleAlert size={14} />
                      {job.options.transport === 'native500' ? 'SDK 历史通道' : '500 条聚合通道'}
                      已移除，此旧任务不能继续；任务记录与已取得缓存保留。
                    </p>
                  ) : null}
                  <div className="weq-roaming-job-meta">
                    <span className="weq-roaming-chip is-quiet">
                      <Radio size={12} />
                      {job.options.transport === 'native500'
                        ? 'SDK 通道已移除（历史任务）'
                        : job.options.transport === 'sso500'
                          ? '聚合通道已移除（历史任务）'
                          : `SSO · ${job.options.intervalMs} ms`}
                    </span>
                    <span className="weq-roaming-chip is-quiet">
                      <History size={12} />
                      待检查窗口 {format(job.estimatedWindows)}
                    </span>
                    <span className="weq-roaming-chip is-quiet">
                      <CalendarRange size={12} />
                      {job.options.range?.start === undefined
                        ? '不限起始'
                        : atBeijing(job.options.range.start * 1000)}
                      {' → '}
                      {job.options.range?.end === undefined
                        ? '不限结束'
                        : atBeijing(job.options.range.end * 1000)}
                    </span>
                    {job.inFlight ? (
                      <span className="weq-roaming-chip is-pending">
                        <Loader2 size={12} className="weq-roaming-spin" />
                        {targetNames.get(job.inFlight.target) ??
                          job.targets.find((target) => targetKey(target) === job.inFlight?.target)
                            ?.name ??
                          job.inFlight.target}{' '}
                        · seq {job.inFlight.start}–{job.inFlight.end} 待复核
                      </span>
                    ) : null}
                  </div>
                  <div className="weq-roaming-job-actions">
                    {['planned', 'paused', 'failed'].includes(job.status) ? (
                      <button
                        type="button"
                        className="weq-roaming-actionbtn is-primary"
                        disabled={
                          busy ||
                          mutating ||
                          job.options.transport === 'native500' ||
                          job.options.transport === 'sso500' ||
                          staleBackend
                        }
                        onClick={() => {
                          setError(null);
                          run.mutate({ id: job.id });
                        }}
                      >
                        <Play size={14} />
                        {job.status === 'planned' ? '开始补全' : '继续'}
                      </button>
                    ) : null}
                    {job.status === 'running' ? (
                      <button
                        type="button"
                        className="weq-roaming-actionbtn is-primary"
                        disabled={mutating}
                        onClick={() => pause.mutate({ id: job.id })}
                      >
                        <Pause size={14} />
                        暂停
                      </button>
                    ) : null}
                    {job.status === 'partial' ? (
                      <button
                        type="button"
                        className="weq-roaming-actionbtn"
                        disabled={
                          busy ||
                          mutating ||
                          job.options.transport === 'native500' ||
                          job.options.transport === 'sso500' ||
                          staleBackend
                        }
                        onClick={() => {
                          setError(null);
                          run.mutate({ id: job.id, retryRemaining: true });
                        }}
                      >
                        <RotateCcw size={14} />
                        重试未补区间
                      </button>
                    ) : null}
                    {!['completed', 'cancelled'].includes(job.status) ? (
                      <button
                        type="button"
                        className="weq-roaming-actionbtn"
                        disabled={mutating || job.status === 'pausing'}
                        onClick={() => cancel.mutate({ id: job.id })}
                      >
                        <Square size={13} />
                        取消
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="weq-roaming-iconbtn is-danger"
                      title="移除任务，保留已取得的消息"
                      aria-label="移除补全任务"
                      disabled={busy || mutating}
                      onClick={() => {
                        void confirm(
                          '移除任务？',
                          '仅移除任务与断点，已经取得的漫游消息会保留。',
                        ).then((ok) => {
                          if (ok) remove.mutate({ id: job.id });
                        });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <details className="weq-roaming-receipts">
                    <summary>
                      <ChevronRight size={13} className="weq-roaming-disclosure" />
                      最近请求记录
                      <small>最多 200 条</small>
                    </summary>
                    <div className="weq-roaming-receipt-list">
                      {[...job.attempts].reverse().map((attempt) => (
                        <div key={attempt.id} className="weq-roaming-receipt">
                          <span className="weq-roaming-receipt-target">
                            {targetNames.get(attempt.target) ??
                              job.targets.find((target) => targetKey(target) === attempt.target)
                                ?.name ??
                              attempt.target}
                            <small>
                              seq {attempt.start}–{attempt.end}
                            </small>
                          </span>
                          <span
                            className={`weq-roaming-chip is-${attempt.outcome === 'observed' ? 'online' : attempt.outcome === 'cache' ? 'quiet' : 'error'}`}
                          >
                            {
                              {
                                cache: '缓存',
                                observed: '取得记录',
                                empty: '空响应，缺口保留',
                                error: '失败，缺口保留',
                              }[attempt.outcome]
                            }
                            {' · '}
                            {attempt.observed} 条
                          </span>
                          {attempt.detail ? <small>{attempt.detail}</small> : null}
                        </div>
                      ))}
                    </div>
                  </details>
                </article>
              );
            })
          ) : (
            <p className="weq-roaming-empty">
              <CloudDownload size={15} />
              尚无批量补全任务，先在上方选择会话并扫描候选缺口。
            </p>
          )}
          {jobs.length ? (
            <p className="weq-roaming-hint is-footer">
              <Info size={13} />
              覆盖口径：实际取得的记录；日期边界来自本地锚点，不证明全部历史完整
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
