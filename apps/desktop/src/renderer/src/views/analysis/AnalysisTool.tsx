import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Play, RotateCw, Search } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useTabActive } from '../../components/RetainedTabs';
import { WindowedList } from '../../components/WindowedList';
import { useViewState } from '../../state/view';
import { createMediaId } from '../../im-template/template/composerMedia';
import {
  ANALYSIS_LABELS,
  analysisDateRange,
  type AnalysisKind,
  type AnalysisReportRequest,
} from './model';
import '../../styles/analysis-tool.css';

type Choice = { id: string; name: string; detail: string };
function ObjectPicker({
  items,
  selected,
  onSelect,
}: {
  items: Choice[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) =>
      `${item.name}\n${item.detail}`.toLocaleLowerCase().includes(needle),
    );
  }, [items, query]);
  return (
    <div className="weq-analysis-picker">
      <label className="weq-analysis-search">
        <Search size={15} />
        <input
          aria-label="搜索分析对象"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="名称或号码"
        />
      </label>
      {filtered.length ? (
        <WindowedList
          items={filtered}
          height={360}
          rowHeight={54}
          itemKey={(item) => item.id}
          resetKey={query}
          label="分析对象"
          renderItem={(item) => (
            <button
              type="button"
              className={`weq-analysis-choice${selected === item.id ? ' is-selected' : ''}`}
              aria-pressed={selected === item.id}
              onClick={() => onSelect(item.id)}
            >
              <strong>{item.name}</strong>
              <small>{item.detail}</small>
            </button>
          )}
        />
      ) : (
        <p className="weq-analysis-state">暂无匹配对象</p>
      )}
    </div>
  );
}

export function AnalysisTool({
  onGenerate,
}: {
  onGenerate: (request: AnalysisReportRequest) => void;
}) {
  const account = useViewState((state) => state.openedUin);
  return (
    <AnalysisToolForm key={account ?? 'no-account'} account={account} onGenerate={onGenerate} />
  );
}

function AnalysisToolForm({
  account,
  onGenerate,
}: {
  account: string | null;
  onGenerate: (request: AnalysisReportRequest) => void;
}) {
  const active = useTabActive() && Boolean(account);
  const [kind, setKind] = useState<AnalysisKind>('annual');
  const [year, setYear] = useState(0);
  const [peer, setPeer] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, string>>({});
  const [chooseGroup, setChooseGroup] = useState(true);
  const [timeMode, setTimeMode] = useState<'all' | 'dates'>('all');
  const [start, setStart] = useState(''),
    [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [account],
  );
  const years = trpc.account.annualReport.getAvailableYears.useQuery(undefined, {
    enabled: active && kind === 'annual',
  });
  const friends = trpc.account.contactsExportPreview.useQuery(
    { scope: 'friends' },
    { enabled: active && kind === 'buddy' },
  );
  const groups = trpc.account.exportGroupDirectory.useQuery(undefined, {
    enabled: active && (kind === 'group' || kind === 'member'),
  });
  const memberList = trpc.account.contactsExportPreview.useQuery(
    { scope: 'group', groupCode: group ?? '1' },
    { enabled: active && kind === 'member' && Boolean(group) && !chooseGroup },
  );
  const groupRows = groups.data ?? [],
    friendRows = friends.data ?? [],
    memberRows = memberList.data ?? [];
  const pickedGroup = groupRows.find((row) => row.groupCode === group);
  const pickedFriend = friendRows.find((row) => row.uid === peer);
  const pickedMember = memberRows.find((row) => row.uid === (group ? members[group] : null));
  const source =
    kind === 'buddy' ? friends : kind === 'member' && !chooseGroup && group ? memberList : groups;
  const items: Choice[] =
    kind === 'buddy'
      ? friendRows.map((row) => ({ id: row.uid, name: row.name, detail: row.uin || row.uid }))
      : kind === 'member' && !chooseGroup && group
        ? memberRows.map((row) => ({ id: row.uid, name: row.name, detail: row.uin || row.uid }))
        : groupRows.map((row) => ({
            id: row.groupCode,
            name: row.groupName,
            detail: row.groupCode,
          }));
  const selected =
    kind === 'buddy'
      ? peer
      : kind === 'member' && !chooseGroup && group
        ? (members[group] ?? null)
        : group;
  const validObject =
    kind === 'annual'
      ? years.data?.includes(year)
      : kind === 'buddy'
        ? pickedFriend
        : kind === 'group'
          ? pickedGroup
          : pickedGroup && pickedMember;
  const submit = async () => {
    if (pending.current || !validObject || !account) return;
    setError(null);
    let range = {};
    try {
      if (kind !== 'annual' && timeMode === 'dates') range = analysisDateRange(start, end);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return;
    }
    const target =
      kind === 'annual'
        ? { kind, year }
        : kind === 'buddy'
          ? { kind, peerUid: pickedFriend!.uid, name: pickedFriend!.name }
          : kind === 'group'
            ? { kind, groupCode: pickedGroup!.groupCode, name: pickedGroup!.groupName }
            : {
                kind,
                groupCode: pickedGroup!.groupCode,
                groupName: pickedGroup!.groupName,
                memberUid: pickedMember!.uid,
                name: pickedMember!.name,
              };
    const period =
      kind === 'annual'
        ? year === 0
          ? '历史以来'
          : `${year} 年`
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
  return (
    <div className="weq-analysis-tool">
      <fieldset disabled={busy} className="weq-analysis-fields">
        <div className="weq-analysis-config">
          <label>
            报告类型
            <select
              aria-label="报告类型"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as AnalysisKind);
                setError(null);
              }}
            >
              {Object.entries(ANALYSIS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {kind === 'annual' ? (
            <label>
              时间
              <select
                aria-label="报告年份"
                value={year}
                onChange={(event) => setYear(Number(event.target.value))}
              >
                {(years.data ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value === 0 ? '历史以来' : `${value} 年`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                时间
                <select
                  aria-label="分析时间范围"
                  value={timeMode}
                  onChange={(event) => setTimeMode(event.target.value as 'all' | 'dates')}
                >
                  <option value="all">全部本地历史</option>
                  <option value="dates">指定日期</option>
                </select>
              </label>
              {timeMode === 'dates' ? (
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
                  <small>北京时间</small>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className="weq-analysis-objects">
          {kind === 'annual' ? (
            years.isLoading ? (
              <p className="weq-analysis-state" role="status">
                正在读取报告年份
              </p>
            ) : years.isError ? (
              <button type="button" onClick={() => void years.refetch()}>
                <RotateCw size={16} />
                重试读取年份
              </button>
            ) : (
              <p className="weq-analysis-state">
                {years.data?.length ? `当前账号 · ${account}` : '当前账号暂无可用报告年份'}
              </p>
            )
          ) : (
            <>
              {kind === 'member' && !chooseGroup && pickedGroup ? (
                <button
                  type="button"
                  className="weq-analysis-group"
                  onClick={() => setChooseGroup(true)}
                >
                  <ArrowLeft size={16} />
                  {pickedGroup.groupName}
                </button>
              ) : null}
              {source.isLoading ? (
                <p className="weq-analysis-state" role="status">
                  正在读取分析对象
                </p>
              ) : source.isError ? (
                <button type="button" onClick={() => void source.refetch()}>
                  <RotateCw size={16} />
                  重试读取对象
                </button>
              ) : (
                <ObjectPicker
                  key={`${kind}:${kind === 'member' && !chooseGroup ? group : 'groups'}`}
                  items={items}
                  selected={selected}
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
        {error ? <span role="alert">{error}</span> : <span />}
        <button
          type="button"
          disabled={!account || !validObject || busy}
          onClick={() => void submit()}
        >
          <Play size={16} />
          {busy ? '正在确认' : '生成报告'}
        </button>
      </footer>
    </div>
  );
}
