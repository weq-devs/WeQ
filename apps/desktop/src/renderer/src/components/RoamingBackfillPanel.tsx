import { useEffect, useMemo, useState } from 'react';
import { CloudDownload, Pause, Play, RotateCcw, ScanSearch, Square, Trash2 } from 'lucide-react';
import { classifyChatType } from '@weq/codec';
import type { RoamingTarget } from '@weq/service';
import { trpc } from '../trpc/client';
import { useDialog } from './Dialog';
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
const atBeijing = (at: number) =>
  new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function RoamingBackfillPanel({ initialTarget }: { initialTarget?: RoamingTarget }) {
  const utils = trpc.useUtils();
  const confirm = useDialog((s) => s.confirm);
  const [selected, setSelected] = useState<string[]>(
    initialTarget && addressable(initialTarget) ? [targetKey(initialTarget)] : [],
  );
  const [query, setQuery] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [beforeOldest, setBeforeOldest] = useState(false);
  const [intervalMs, setIntervalMs] = useState(500);
  const [maxRequests, setMaxRequests] = useState(200);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = trpc.account.roamingBackfill.list.useQuery(undefined, {
    refetchInterval: 1000,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const contacts = trpc.account.listConversationsWithCount.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const refresh = () => {
    void utils.account.roamingBackfill.list.invalidate();
  };
  const onError = (e: { message: string }) => setError(e.message);
  const plan = trpc.account.roamingBackfill.plan.useMutation({
    onSuccess: (task) => {
      setTaskId(task.id);
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
  const targets = useMemo(() => {
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
    if (initialTarget && addressable(initialTarget))
      map.set(targetKey(initialTarget), initialTarget);
    return [...map.values()];
  }, [contacts.data, initialTarget]);
  const initialKey = initialTarget && addressable(initialTarget) ? targetKey(initialTarget) : null;
  useEffect(() => {
    if (initialKey)
      setSelected((current) => (current.includes(initialKey) ? current : [...current, initialKey]));
  }, [initialKey]);
  const jobs = state.data?.jobs ?? [];
  const job =
    jobs.find((item) => item.id === taskId) ??
    jobs.find((item) => item.id === state.data?.activeId) ??
    jobs[0];
  const visible = targets.filter((target) =>
    `${target.name} ${target.conv}`.toLowerCase().includes(query.toLowerCase()),
  );

  function scan() {
    setError(null);
    const range = {
      start: start ? Date.parse(`${start}T00:00:00+08:00`) / 1000 : undefined,
      end: end ? Date.parse(`${end}T23:59:59+08:00`) / 1000 : undefined,
    };
    plan.mutate({
      targets: targets.filter((target) => selected.includes(targetKey(target))),
      range,
      beforeOldest,
      intervalMs,
      maxRequests,
    });
  }

  return (
    <div className="weq-roaming-panel">
      <header className="weq-wtools-pane-head">
        <div className="weq-wtools-pane-title">
          <CloudDownload size={17} />
          <h2 id="weq-wtools-title">批量补全缺失消息</h2>
        </div>
        <span className="weq-roaming-access">
          {state.data
            ? state.data.online
              ? '当前账号 QQ 在线'
              : '离线 · 可扫描本地锚点及复核缓存'
            : '读取任务状态中'}
        </span>
      </header>
      <div className="weq-roaming-body">
        {state.error || error ? (
          <p role="alert" className="weq-roaming-error">
            {error ?? state.error?.message}
          </p>
        ) : null}
        {contacts.error ? (
          <p role="alert" className="weq-roaming-error">
            会话列表读取失败：{contacts.error.message}
          </p>
        ) : null}
        <section aria-label="补全范围" className="weq-roaming-scope">
          <h3>新建补全任务</h3>
          <div className="weq-roaming-fields">
            <label>
              开始日期（北京时间）
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              结束日期（北京时间）
              <input
                type="date"
                value={end}
                min={start || undefined}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <label>
              请求间隔（毫秒）
              <input
                type="number"
                min={500}
                max={60000}
                step={100}
                value={intervalMs}
                onChange={(e) => setIntervalMs(Number(e.target.value))}
              />
            </label>
            <label>
              本轮在线请求预算
              <input
                type="number"
                min={1}
                max={10000}
                value={maxRequests}
                onChange={(e) => setMaxRequests(Number(e.target.value))}
              />
            </label>
          </div>
          <label className="weq-roaming-checkbox">
            <input
              type="checkbox"
              checked={beforeOldest}
              onChange={(e) => setBeforeOldest(e.target.checked)}
            />
            包含最早本地锚点之前的未知区间
          </label>
          <div className="weq-roaming-selection-head">
            <input
              type="search"
              aria-label="搜索补全会话"
              placeholder="搜索会话"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span>已选 {selected.length} / 100</span>
          </div>
          <div className="weq-roaming-targets" aria-label="补全会话">
            {contacts.isLoading ? (
              <p>正在读取会话…</p>
            ) : visible.length === 0 ? (
              <p>没有匹配的可补全会话</p>
            ) : (
              visible.map((target) => {
                const id = targetKey(target);
                return (
                  <label key={id} className="weq-roaming-target">
                    <input
                      type="checkbox"
                      checked={selected.includes(id)}
                      disabled={!selected.includes(id) && selected.length >= 100}
                      onChange={(e) =>
                        setSelected((current) =>
                          e.target.checked
                            ? [...current, id]
                            : current.filter((item) => item !== id),
                        )
                      }
                    />
                    <span>
                      <strong>{target.name}</strong>
                      <small>
                        {target.kind === 'group' ? '群聊' : '私聊'} · {target.conv}
                      </small>
                    </span>
                  </label>
                );
              })
            )}
          </div>
          <div className="weq-roaming-actions">
            <span>最近会话列表上限 1,000；无本地锚点的历史覆盖未知</span>
            <button
              type="button"
              disabled={!selected.length || busy || mutating || Boolean(state.error)}
              onClick={scan}
            >
              <ScanSearch size={15} />
              {plan.isLoading || state.data?.scanning ? '扫描中…' : '扫描候选缺口'}
            </button>
          </div>
        </section>
        <section className="weq-roaming-task" aria-label="补全任务">
          <div className="weq-roaming-task-head">
            <h3>补全任务</h3>
            <select
              aria-label="选择补全任务"
              value={job?.id ?? ''}
              onChange={(e) => setTaskId(e.target.value)}
            >
              {!jobs.length ? (
                <option value="">暂无任务</option>
              ) : (
                jobs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {atBeijing(item.createdAt)} · {item.targets.length} 个会话 ·{' '}
                    {labels[item.status]}
                  </option>
                ))
              )}
            </select>
          </div>
          {job ? (
            <>
              <div className="weq-roaming-task-status">
                <strong>{labels[job.status]}</strong>
                <span>{job.targets.map((target) => target.name).join('、')}</span>
              </div>
              <dl className="weq-roaming-stats">
                {(
                  [
                    ['候选 seq', job.plannedSeqs],
                    ['实际覆盖 seq', job.plannedSeqs - job.remainingSeqs],
                    ['仍未确认 seq', job.remainingSeqs],
                    ['尚待检查 seq', job.pendingSeqs],
                    ['在线请求尝试', job.requests],
                    ['缓存命中窗口', job.cacheWindows],
                    ['失败次数', job.errors],
                    ['内容为空或未解析', job.unparsedOrEmpty],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{format(value)}</dd>
                  </div>
                ))}
              </dl>
              <p className="weq-roaming-boundary">{job.note}</p>
              <div className="weq-roaming-task-meta">
                <span>
                  待检查窗口上限 {format(job.estimatedWindows)} · 间隔 {job.options.intervalMs} ms ·
                  每轮预算 {job.options.maxRequests}
                </span>
                <span>
                  范围：
                  {job.options.range?.start === undefined
                    ? '不限起始'
                    : atBeijing(job.options.range.start * 1000)}{' '}
                  至{' '}
                  {job.options.range?.end === undefined
                    ? '不限结束'
                    : atBeijing(job.options.range.end * 1000)}
                </span>
                {job.inFlight ? (
                  <span>
                    待复核窗口：{job.inFlight.target} · seq {job.inFlight.start}–{job.inFlight.end}
                    ，尚未提交覆盖
                  </span>
                ) : null}
                <span>覆盖口径：实际取得的记录；日期边界来自本地锚点，不证明全部历史完整</span>
              </div>
              <div className="weq-roaming-actions">
                {['planned', 'paused', 'failed'].includes(job.status) ? (
                  <button
                    type="button"
                    disabled={busy || mutating}
                    onClick={() => {
                      setError(null);
                      run.mutate({ id: job.id });
                    }}
                  >
                    <Play size={15} />
                    {job.status === 'planned' ? '开始补全' : '继续'}
                  </button>
                ) : null}
                {job.status === 'running' ? (
                  <button
                    type="button"
                    disabled={mutating}
                    onClick={() => pause.mutate({ id: job.id })}
                  >
                    <Pause size={15} />
                    暂停
                  </button>
                ) : null}
                {job.status === 'partial' ? (
                  <button
                    type="button"
                    disabled={busy || mutating}
                    onClick={() => {
                      setError(null);
                      run.mutate({ id: job.id, retryRemaining: true });
                    }}
                  >
                    <RotateCcw size={15} />
                    重试未补区间
                  </button>
                ) : null}
                {!['completed', 'cancelled'].includes(job.status) ? (
                  <button
                    type="button"
                    disabled={mutating || job.status === 'pausing'}
                    onClick={() => cancel.mutate({ id: job.id })}
                  >
                    <Square size={15} />
                    取消任务
                  </button>
                ) : null}
                <button
                  type="button"
                  title="移除任务，保留已取得的消息"
                  aria-label="移除补全任务"
                  disabled={busy || mutating}
                  onClick={() => {
                    void confirm('移除任务？', '仅移除任务与断点，已经取得的漫游消息会保留。').then(
                      (ok) => {
                        if (ok) remove.mutate({ id: job.id });
                      },
                    );
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <details className="weq-roaming-receipts">
                <summary>最近请求记录（最多 200 条）</summary>
                <div className="weq-roaming-receipt-list">
                  {[...job.attempts].reverse().map((attempt) => (
                    <div key={attempt.id}>
                      <span>
                        {attempt.target} · {attempt.start}–{attempt.end}
                      </span>
                      <span>
                        {
                          {
                            cache: '缓存',
                            observed: '取得记录',
                            empty: '空响应，缺口保留',
                            error: '失败，缺口保留',
                          }[attempt.outcome]
                        }{' '}
                        · {attempt.observed} 条
                      </span>
                      {attempt.detail ? <small>{attempt.detail}</small> : null}
                    </div>
                  ))}
                </div>
              </details>
            </>
          ) : (
            <p className="weq-roaming-boundary">尚无批量补全任务</p>
          )}
        </section>
      </div>
    </div>
  );
}
