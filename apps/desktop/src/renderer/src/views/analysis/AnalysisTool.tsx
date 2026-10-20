import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, Play, RotateCw, Search, Users } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useTabActive } from '../../components/RetainedTabs';
import { WindowedList } from '../../components/WindowedList';
import { QqAvatar } from '../../components/QqAvatar';
import { useViewState } from '../../state/view';
import { createMediaId } from '../../im-template/template/composerMedia';
import { MessageCalendar } from '../../components/MessageCalendar';
import { beijingDay } from '../../lib/messageCalendar';
import { GroupAvatar } from '../../components/exportAvatars';
import {
  ANALYSIS_LABELS,
  ANALYSIS_TOOL_KINDS,
  analysisDateRange,
  type AnalysisTarget,
  type AnalysisToolKind,
  type AnalysisReportRequest,
} from './model';
import '../../styles/analysis-tool.css';

/** 私聊目录行（analysisPeerDirectory）。 */
interface PeerRow {
  uid: string;
  uin: string;
  name: string;
  source: 'directory' | 'messages';
  /** 最近一条消息时间（unix 秒，0 = 没有本地记录）。 */
  lastMessageTime?: number;
}
/** 群目录行（analysisGroupDirectory）。 */
interface GroupRow {
  groupCode: string;
  groupName: string;
  memberCount: number;
  source: 'directory' | 'messages';
  lastMessageTime?: number;
}
/** 群成员目录行（analysisMemberDirectory）。 */
interface MemberRow {
  id: string;
  uid: string;
  uin: string;
  name: string;
  source: 'directory' | 'messages';
  lastMessageTime?: number;
}

type Choice = {
  id: string;
  name: string;
  detail: string;
  /** 头像：好友用 uid + uin，群用群号，成员同理。 */
  avatar?: { uid?: string; uin?: string; groupCode?: string; kind: 'buddy' | 'group' };
  lastMessageTime: number;
  badge?: string;
};

/** 「最近聊过」的相对时间标签，避免列表里一堆绝对日期。 */
function relativeTime(seconds: number): string {
  if (!seconds) return '';
  const day = new Date(seconds * 1000);
  const diff = Date.now() - day.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return beijingDay(day);
}

function ObjectPicker({
  items,
  selected,
  onSelect,
  emptyText = '暂无匹配对象',
  title,
  trailing,
  loading = false,
}: {
  items: Choice[];
  selected: string | null;
  onSelect: (id: string) => void;
  emptyText?: string;
  title?: string;
  trailing?: React.ReactNode;
  /** 加载中：保留搜索框与卡片高度，列表位置换成骨架 + 扫光。 */
  loading?: boolean;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.name}\n${item.detail}`.toLocaleLowerCase().includes(needle),
    );
  }, [items, query]);
  return (
    <div className="weq-analysis-picker">
      <div className="weq-analysis-picker-head">
        {loading ? (
          // 加载中也保留搜索框的位置与尺寸，只是不可输入。
          <span className="weq-analysis-search is-static">
            <Search size={15} />
            <span>名称或号码</span>
          </span>
        ) : (
          <label className="weq-analysis-search">
            <Search size={15} />
            <input
              aria-label="搜索分析对象"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="名称或号码"
            />
          </label>
        )}
        {loading ? null : trailing}
      </div>
      {title ? <p className="weq-analysis-picker-title">{title}</p> : null}
      {loading ? (
        <div className="weq-analysis-skeleton" aria-hidden>
          {Array.from({ length: 8 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
            <div className="weq-analysis-skeleton-row" key={index}>
              <span className="weq-analysis-skeleton-avatar" />
              <span className="weq-analysis-skeleton-main">
                <span className="weq-analysis-skeleton-line" />
                <span className="weq-analysis-skeleton-line is-short" />
              </span>
            </div>
          ))}
        </div>
      ) : filtered.length ? (
        <WindowedList
          items={filtered}
          height={420}
          rowHeight={58}
          itemKey={(item) => item.id}
          resetKey={query}
          label="分析对象"
          renderItem={(item) => {
            const active = selected === item.id;
            return (
              <button
                type="button"
                className={`weq-analysis-choice${active ? ' is-selected' : ''}`}
                aria-pressed={active}
                onClick={() => onSelect(item.id)}
                data-analysis-choice={item.id}
              >
                <span className="weq-analysis-choice-avatar" aria-hidden>
                  {item.avatar?.kind === 'group' ? (
                    <GroupAvatar code={item.avatar.groupCode ?? ''} size={34} />
                  ) : (
                    <QqAvatar uin={item.avatar?.uin || null} size={34} />
                  )}
                </span>
                <span className="weq-analysis-choice-body">
                  <span className="weq-analysis-choice-name">
                    <strong>{item.name}</strong>
                    {item.badge ? <em>{item.badge}</em> : null}
                  </span>
                  <small>{item.detail}</small>
                </span>
                {item.lastMessageTime ? (
                  <span className="weq-analysis-choice-time">
                    {relativeTime(item.lastMessageTime)}
                  </span>
                ) : null}
              </button>
            );
          }}
        />
      ) : (
        <p className="weq-analysis-state">{emptyText}</p>
      )}
    </div>
  );
}

/**
 * 报告类型选择：横向排列的小号分段控件。
 *
 * 年度报告有独立入口（侧栏），这里只列群聊 / 好友 / 群成员三类。
 */
function KindTabs({
  value,
  onChange,
  disabled,
}: {
  value: AnalysisToolKind;
  onChange: (kind: AnalysisToolKind) => void;
  disabled?: boolean;
}) {
  return (
    <div className="weq-analysis-kinds" role="tablist" aria-label="切换报告类型">
      {/* 隐藏的原生 select 只承担无障碍 / 键盘语义（读屏与自动化都按「报告类型」找它）。 */}
      <select
        className="weq-analysis-kind-native"
        aria-label="报告类型"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as AnalysisToolKind)}
      >
        {ANALYSIS_TOOL_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {ANALYSIS_LABELS[kind]}
          </option>
        ))}
      </select>
      {ANALYSIS_TOOL_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="tab"
          aria-selected={kind === value}
          className={kind === value ? 'is-active' : ''}
          disabled={disabled}
          onClick={() => onChange(kind)}
        >
          {ANALYSIS_LABELS[kind]}
        </button>
      ))}
    </div>
  );
}

export function AnalysisTool({
  onGenerate,
  initialTarget,
  messageIds,
  fixedTarget = true,
}: {
  onGenerate: (request: AnalysisReportRequest) => void;
  initialTarget?: AnalysisTarget;
  messageIds?: string[];
  fixedTarget?: boolean;
}) {
  const account = useViewState((state) => state.openedUin);
  return (
    <AnalysisToolForm
      key={JSON.stringify([account, initialTarget, fixedTarget])}
      account={account}
      onGenerate={onGenerate}
      initialTarget={initialTarget}
      messageIds={messageIds}
      fixedTarget={fixedTarget}
    />
  );
}

function AnalysisToolForm({
  account,
  onGenerate,
  initialTarget,
  messageIds,
  fixedTarget,
}: {
  account: string | null;
  onGenerate: (request: AnalysisReportRequest) => void;
  initialTarget?: AnalysisTarget;
  messageIds?: string[];
  fixedTarget: boolean;
}) {
  const lockedTarget = fixedTarget ? initialTarget : undefined;
  const active = useTabActive() && Boolean(account);
  // 年度报告有独立入口，这里默认落「群聊分析」（最常用的那类）。
  const [kind, setKind] = useState<AnalysisToolKind>(initialTarget?.kind ?? 'group');
  const [peer, setPeer] = useState<string | null>(
    initialTarget?.kind === 'buddy' ? initialTarget.peerUid : null,
  );
  const [group, setGroup] = useState<string | null>(
    initialTarget && initialTarget.kind !== 'buddy' ? initialTarget.groupCode : null,
  );
  const [members, setMembers] = useState<Record<string, string>>({});
  const [chooseGroup, setChooseGroup] = useState(initialTarget?.kind !== 'member');
  const [timeMode, setTimeMode] = useState<'all' | 'dates'>('all');
  const [start, setStart] = useState(''),
    [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    generation = useRef(0);
  /** 换账号时作废进行中的提交，并把「正在提交」解锁，别让界面卡在禁用态。 */
  const accountRef = useRef(account);
  useEffect(() => {
    if (accountRef.current === account) return;
    accountRef.current = account;
    generation.current++;
    pending.current = false;
    setBusy(false);
    setError(null);
  }, [account]);
  const friends = trpc.account.analysisPeerDirectory.useQuery(
    { expectedAccountUin: account ?? '' },
    { enabled: active && kind === 'buddy' },
  );
  const groups = trpc.account.analysisGroupDirectory.useQuery(
    { expectedAccountUin: account ?? '' },
    { enabled: active && (kind === 'group' || kind === 'member') },
  );
  const memberList = trpc.account.analysisMemberDirectory.useQuery(
    { groupCode: group ?? '1', expectedAccountUin: account ?? '' },
    { enabled: active && kind === 'member' && Boolean(group) && !chooseGroup },
  );
  // 日历按当前对象统计每日消息量，让「指定日期」能直接看到哪里有记录。
  const calendarTargets = (() => {
    if (kind === 'buddy' && peer) return [{ kind: 'c2c' as const, conv: peer }];
    if (kind === 'group' && group) return [{ kind: 'group' as const, conv: group }];
    if (kind === 'member' && group) return [{ kind: 'group' as const, conv: group }];
    return [];
  })();
  const calendar = trpc.account.exportCalendar.useQuery(
    { targets: calendarTargets },
    {
      enabled: active && calendarTargets.length > 0 && timeMode === 'dates',
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  );
  const groupRows = (groups.data ?? []) as GroupRow[];
  const friendRows = (friends.data ?? []) as PeerRow[];
  const memberRows = (memberList.data ?? []) as MemberRow[];
  const pickedGroup = groupRows.find((row) => row.groupCode === group);
  const pickedFriend = friendRows.find((row) => row.uid === peer);
  const initialMember =
    initialTarget?.kind === 'member' && group === initialTarget.groupCode
      ? memberRows.find((row) =>
          initialTarget.memberUid
            ? row.uid === initialTarget.memberUid
            : row.uin === initialTarget.memberUin,
        )
      : undefined;
  const selectedMemberId = group ? (members[group] ?? initialMember?.id ?? null) : null;
  const pickedMember = memberRows.find((row) => row.id === selectedMemberId);

  const items: Choice[] =
    kind === 'buddy'
      ? friendRows.map((row) => ({
          id: row.uid ?? row.name,
          name: row.name,
          detail: row.uin || row.uid || '',
          avatar: { uid: row.uid, uin: row.uin, kind: 'buddy' },
          lastMessageTime: row.lastMessageTime ?? 0,
        }))
      : kind === 'member' && !chooseGroup && group
        ? memberRows.map((row) => ({
            id: row.id,
            name: row.name,
            detail: row.uin || row.uid || '',
            avatar: { uid: row.uid, uin: row.uin, kind: 'buddy' },
            lastMessageTime: row.lastMessageTime ?? 0,
            badge: row.source === 'messages' ? '仅本地记录' : undefined,
          }))
        : groupRows.map((row) => ({
            id: row.groupCode,
            name: row.groupName || row.groupCode,
            detail: row.groupCode,
            avatar: { groupCode: row.groupCode, kind: 'group' },
            lastMessageTime: row.lastMessageTime ?? 0,
            badge: row.source === 'messages' ? '仅本地记录' : undefined,
          }));
  const selected =
    kind === 'buddy' ? peer : kind === 'member' && !chooseGroup && group ? selectedMemberId : group;
  const source =
    kind === 'buddy' ? friends : kind === 'member' && !chooseGroup && group ? memberList : groups;
  const validObject =
    kind === 'buddy' ? pickedFriend : kind === 'group' ? pickedGroup : pickedGroup && pickedMember;
  const submit = async () => {
    if (pending.current || !validObject || !account) return;
    setError(null);
    let range = {};
    try {
      if (timeMode === 'dates' && messageIds === undefined) range = analysisDateRange(start, end);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return;
    }
    const target =
      kind === 'buddy'
        ? { kind, peerUid: pickedFriend!.uid, name: pickedFriend!.name }
        : kind === 'group'
          ? { kind, groupCode: pickedGroup!.groupCode, name: pickedGroup!.groupName }
          : {
              kind,
              groupCode: pickedGroup!.groupCode,
              groupName: pickedGroup!.groupName,
              memberUid: pickedMember!.uid,
              memberUin: pickedMember!.uin || undefined,
              name: pickedMember!.name,
            };
    const period =
      messageIds !== undefined
        ? `已选 ${messageIds.length} 条消息`
        : timeMode === 'all'
          ? '全部本地历史'
          : `${start} 至 ${end} · 北京时间`;
    const run = generation.current;
    pending.current = true;
    setBusy(true);
    try {
      const config = await client.account.getAccountConfig.query();
      if (generation.current !== run || useViewState.getState().openedUin !== account) return;
      if (config?.uin !== account || !config.configId)
        throw new Error('账号数据源已变化，请重新打开分析工具。');
      const scope = {
        expectedAccountUin: account,
        expectedAccountConfigId: config.configId,
        ...range,
        ...(messageIds !== undefined ? { messageIds: [...messageIds] } : {}),
      };
      onGenerate({ id: createMediaId('analysis-report'), scope, period, ...target });
    } catch (error) {
      if (generation.current === run)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === run) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  /** 对象选择器的说明行：随当前种类变化，但不再出现「当前账号 xxx」。 */
  const pickerTitle =
    kind === 'buddy' ? '按最近聊天排序' : kind === 'group' ? '按最近活跃排序' : '按最近发言排序';

  function pickDay(day: string) {
    if (!start || end) {
      setStart(day);
      setEnd('');
      return;
    }
    if (day < start) {
      setEnd(start);
      setStart(day);
    } else setEnd(day);
  }

  // 报告类型由入口决定：主按钮直达当前会话时锁死对象，其余情况在这里横向切换。
  const showKinds = !lockedTarget;

  return (
    <div className="weq-analysis-tool">
      {showKinds ? (
        <header className="weq-analysis-tool-head">
          <KindTabs
            value={kind}
            disabled={busy}
            onChange={(next) => {
              setKind(next);
              setError(null);
            }}
          />
        </header>
      ) : lockedTarget ? (
        <header className="weq-analysis-tool-head">
          <span className="weq-analysis-locked">
            <strong>{ANALYSIS_LABELS[lockedTarget.kind]}</strong>
            {(pickedFriend?.name ?? pickedGroup?.groupName)
              ? ` · ${pickedFriend?.name ?? pickedGroup?.groupName}`
              : ''}
          </span>
        </header>
      ) : null}
      <fieldset disabled={busy} className="weq-analysis-fields">
        <aside className="weq-analysis-config">
          {messageIds !== undefined ? (
            <section className="weq-analysis-card">
              <h3>分析范围</h3>
              <p className="weq-analysis-scope-note">已选 {messageIds.length} 条消息</p>
            </section>
          ) : (
            <section className="weq-analysis-card">
              <h3>时间范围</h3>
              <div className="weq-analysis-time-modes">
                <button
                  type="button"
                  aria-pressed={timeMode === 'all'}
                  className={timeMode === 'all' ? 'is-on' : ''}
                  onClick={() => setTimeMode('all')}
                >
                  全部本地历史
                </button>
                <button
                  type="button"
                  aria-pressed={timeMode === 'dates'}
                  className={timeMode === 'dates' ? 'is-on' : ''}
                  onClick={() => {
                    setTimeMode('dates');
                    if (!start) setStart(beijingDay());
                  }}
                >
                  <CalendarDays size={13} /> 指定日期
                </button>
              </div>
              <select
                className="weq-analysis-kind-native"
                aria-label="分析时间范围"
                value={timeMode}
                onChange={(event) => setTimeMode(event.target.value as 'all' | 'dates')}
              >
                <option value="all">全部本地历史</option>
                <option value="dates">指定日期</option>
              </select>
              {timeMode === 'dates' ? (
                <>
                  <p className="weq-analysis-range">
                    <span>{start || '开始'}</span>
                    <span aria-hidden>→</span>
                    <span>{end || '结束'}</span>
                    <small>北京时间</small>
                  </p>
                  <div className="weq-analysis-dates">
                    <label>
                      开始日期
                      <input
                        type="date"
                        aria-label="开始日期"
                        value={start}
                        onChange={(event) => setStart(event.target.value)}
                      />
                    </label>
                    <label>
                      结束日期
                      <input
                        type="date"
                        aria-label="结束日期"
                        value={end}
                        onChange={(event) => setEnd(event.target.value)}
                      />
                    </label>
                  </div>
                  <MessageCalendar
                    days={calendar.data ?? []}
                    start={start}
                    end={end}
                    allowEmpty
                    loading={calendar.isLoading}
                    key={calendarTargets.map((t) => `${t.kind}:${t.conv}`).join(',') || 'none'}
                    busy={busy}
                    error={calendar.error?.message}
                    onPick={pickDay}
                  />
                </>
              ) : (
                <p className="weq-analysis-scope-note">不限制时间，统计本地已有的全部记录。</p>
              )}
            </section>
          )}
        </aside>

        <div className="weq-analysis-objects">
          {/*
            加载中 / 已锁定对象但目录还没读到时，用同一张卡片 + 骨架占位：
            卡片高度从一开始就是最终高度，列表读完的一刻不会跳。
          */}
          {source.isLoading || (lockedTarget && !source.isError && !validObject) ? (
            <ObjectPicker
              items={[]}
              selected={null}
              loading
              title={pickerTitle}
              onSelect={() => undefined}
            />
          ) : lockedTarget &&
            validObject &&
            (lockedTarget.kind !== 'member' || pickedMember) &&
            !source.isError ? (
            <div className="weq-analysis-locked-target">
              <span className="weq-analysis-choice-avatar" aria-hidden>
                {lockedTarget.kind === 'group' ? (
                  <GroupAvatar code={lockedTarget.groupCode} size={52} />
                ) : (
                  <QqAvatar uin={pickedFriend?.uin || null} size={52} />
                )}
              </span>
              <strong>
                {lockedTarget.kind === 'member'
                  ? pickedMember?.name
                  : (pickedFriend?.name ?? pickedGroup?.groupName)}
              </strong>
              <small>{ANALYSIS_LABELS[lockedTarget.kind]}</small>
            </div>
          ) : (
            <>
              {kind === 'member' && !chooseGroup && pickedGroup ? (
                <button
                  type="button"
                  className="weq-analysis-group"
                  onClick={() => setChooseGroup(true)}
                >
                  <ArrowLeft size={15} />
                  <Users size={15} />
                  {pickedGroup.groupName || pickedGroup.groupCode}
                </button>
              ) : null}
              {source.isError ? (
                <button
                  type="button"
                  className="weq-analysis-retry"
                  onClick={() => void source.refetch()}
                >
                  <RotateCw size={14} /> 重试读取对象
                </button>
              ) : lockedTarget && lockedTarget.kind !== 'member' ? (
                <p role="alert">本地目录中未找到此分析对象。</p>
              ) : (
                <ObjectPicker
                  key={`${kind}:${kind === 'member' && !chooseGroup ? group : 'groups'}`}
                  items={items}
                  selected={selected}
                  title={pickerTitle}
                  loading={source.isLoading}
                  emptyText={kind === 'buddy' ? '没有可分析的私聊对象' : '没有可分析的群聊'}
                  onSelect={(id) => {
                    if (kind === 'buddy') setPeer(id);
                    else if (kind === 'member' && !chooseGroup && group)
                      setMembers((previous) => ({ ...previous, [group]: id }));
                    else {
                      setGroup(id);
                      if (kind === 'member') setChooseGroup(false);
                    }
                  }}
                />
              )}
            </>
          )}
        </div>
      </fieldset>
      <footer className="weq-analysis-foot">
        {error ? <span role="alert">{error}</span> : <span className="weq-analysis-hint" />}
        <button
          type="button"
          disabled={!account || !validObject || busy}
          onClick={() => void submit()}
        >
          <Play size={14} />
          {busy ? '正在确认' : '生成报告'}
        </button>
      </footer>
    </div>
  );
}
