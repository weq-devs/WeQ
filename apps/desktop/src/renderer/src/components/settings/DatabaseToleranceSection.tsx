import * as timeFormat from '@weq/time';
import { eventTimeFormatter } from '@weq/time';
/**
 * 设置 → QQ 数据库管理 → 容错与修复。
 *
 * 这一屏要回答三个问题，顺序也就是版面顺序：
 *   1. **现在是什么级别**（紧凑选择器，保留实验性标识）；
 *   2. **想开哪一级，代价是什么**（有损级别在选择器旁原位确认，详细范围折叠）；
 *   3. **到底降级过什么**（账本、隔离清单）。
 *
 * 坏页扫描继续复用本页的修复工具，级别选择不另起扫描实现。
 *
 * 三条不变量，界面文案必须与之保持一致：
 *   1. **默认严格**：级别 0 始终保留为选项。
 *   2. **会丢数据的级别必须当场确认**：确认紧邻选择器，且带 `aria-live` 提示。
 *   3. **降级可见**：账本、坏页清单都在这一屏，随时可看。
 *
 * 文案一律取自 `@weq/service` 的 `db_tolerance_copy.ts`（那份带守卫测试）。
 * 这里是**渲染**，不是口径的出处 —— 想改口径请改那个模块，否则文案会漂。
 *
 * 版面注意：账本、隔离清单都是"内容驱动宽度"的块，**不能**放进 `Row` 的右侧控件位
 * （`.weq-set-row-ctrl` 是 `flex: none`，宽度跟着内容走，一行字一多就顶破卡片边框）。
 * 它们统一用 `.weq-set-block` / `.weq-set-chips` 单独占一整行。
 *
 * 后端契约（account router）：
 *   - getDbTolerance           — { level, grantedAt, summary, entries }
 *   - setDbToleranceLevel      — { level, source? } → { level, grantedAt, closedSalvage }
 *   - listSalvageQuarantine    — 被整表放弃（隔离）的清单
 *   - clearSalvageQuarantine   — 让它重新试一次
 */

import { useState, type ReactElement, type ReactNode, type ComponentProps } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  DatabaseZap,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  ScrollText,
  Table2,
} from 'lucide-react';
import {
  SALVAGE_AGGREGATE_CAVEAT,
  SALVAGE_EXPERIMENTAL_NOTE,
  SALVAGE_EXPERIMENTAL_TAG,
  SALVAGE_SKIPPED_SPAN_CAVEAT,
  salvageLevelToast,
  salvageLevelCopy,
  salvageLevelsAscending,
} from '@weq/service/db-tolerance-copy';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle, QueryError } from './controls';

function ToleranceGroup({
  embedded,
  scope,
  ...props
}: ComponentProps<typeof Card> & { embedded: boolean; scope?: string }) {
  return embedded ? (
    <section className="weq-database-setting-group" data-setting-id={props.settingId}>
      {(props.title || scope || props.action) && (
        <div className="weq-database-group-head">
          <h4>{props.title}</h4>
          {scope && <span>{scope}</span>}
          {props.settingId === 'db-tolerance' && (
            <span className="weq-set-exp-badge" title={SALVAGE_EXPERIMENTAL_NOTE}>
              <FlaskConical size={11} aria-hidden />
              {SALVAGE_EXPERIMENTAL_TAG}
            </span>
          )}
          {props.action}
        </div>
      )}
      {props.children}
    </section>
  ) : (
    <Card {...props} />
  );
}

/** 账本里一条记录的渲染层视图。 */
interface LedgerEntryView {
  at: string;
  dbPath: string;
  level: number;
  /** `index-retreat` 不丢数据；其余三种都会少数据（隔离是"压根没读"）。 */
  kind: 'index-retreat' | 'unrecoverable' | 'skipped-ranges' | 'quarantined';
  errorKind: string;
  errorCode: number | null;
  sqlFingerprint: string;
  /**
   * 仅 `skipped-ranges`：跳过了几处，以及这些区间的 key 跨度合计。
   *
   * 跨度**不是行数上界**（同一个 key 可能对应多行 —— 共享 seq 的灰条、贴表情），
   * 所以界面只能说"哪一段读不出来"。口径以 `SALVAGE_SKIPPED_SPAN_CAVEAT` 为准。
   */
  skippedRangeCount?: number;
  skippedSpanUpperBound?: number;
  /** 人类可读的一句话（跳过区间的位置就在这里）。 */
  message?: string | null;
}

/** 被整表放弃（隔离）的一张表。 */
interface QuarantineEntryView {
  dbPath: string;
  table: string;
  errorKind: string;
  since: number;
  failures: number;
}

/** 账本条目的类别文案与是否"丢过数据"。 */
const LEDGER_KINDS: Record<
  LedgerEntryView['kind'],
  { label: string; losesData: boolean; hint: string }
> = {
  'index-retreat': {
    label: '换了访问路径 · 未丢数据',
    losesData: false,
    hint: '同一条查询换一种读法拿到了完整结果。',
  },
  unrecoverable: {
    label: '替代路径也读不出来',
    losesData: true,
    hint: '本次读取没有结果（内容可能已丢失）。',
  },
  'skipped-ranges': {
    label: '跳过了读不出来的区间 · 少数据',
    losesData: true,
    hint: '拿到了结果，但跳过的区间内可能有消息未被读出。',
  },
  quarantined: {
    label: '已放弃该表',
    losesData: true,
    hint: '该表连续读不动，被隔离以保证其它表可用。',
  },
};

/** 只取文件名：完整路径在这一屏里既长又没有信息量。 */
function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index >= 0 ? path.slice(index + 1) : path;
}

/** 容错记录的完整北京时间；非法值保留原文供诊断。 */
function shortTime(iso: string): string {
  return timeFormat.formatDateTime(iso) || iso;
}

export function DatabaseToleranceSection({
  page = 'policy',
  onOpenRecords,
  repairAction,
}: {
  page?: 'policy' | 'status' | 'damage' | 'management';
  onOpenRecords?: () => void;
  repairAction?: ReactNode;
}): ReactElement {
  const embedded = page === 'management';
  const pushToast = useToast((s) => s.push);
  const autoRefresh = useQQAutoRefresh(true);
  const utils = trpc.useUtils();
  const tolerance = trpc.account.getDbTolerance.useQuery(undefined, {
    ...autoRefresh,
    enabled: autoRefresh.enabled && page !== 'damage',
  });
  const setLevel = trpc.account.setDbToleranceLevel.useMutation();
  const quarantine = trpc.account.listSalvageQuarantine.useQuery(undefined, {
    ...autoRefresh,
    enabled: autoRefresh.enabled && page !== 'damage',
  });
  const clearQuarantine = trpc.account.clearSalvageQuarantine.useMutation();

  /** 正在等用户确认的**那个**级别；确认条就渲染在这一行里面。 */
  const [pendingLossy, setPendingLossy] = useState<number | null>(null);
  // 弹窗提醒开关。它存在 AppSettings 里（不是宽容级别那一套），所以单独查一次。
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: autoRefresh.enabled && (page === 'damage' || embedded),
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setReminder = trpc.bootstrap.setSuppressDbDamageReminder.useMutation();
  const remindOnDamage = settings.data ? !settings.data.suppressDbDamageReminder : true;

  const level = tolerance.data?.level ?? 0;
  const grantedAt = tolerance.data?.grantedAt ?? null;
  const summary = tolerance.data?.summary;
  const entries = (tolerance.data?.entries ?? []) as LedgerEntryView[];
  const hasLedger = Boolean(summary && summary.total > 0);
  const quarantined = (quarantine.data ?? []) as QuarantineEntryView[];

  const changeLevel = async (next: number): Promise<void> => {
    setPendingLossy(null);
    try {
      const result = await setLevel.mutateAsync({ level: next, source: 'settings' });
      await Promise.all([
        utils.account.getDbTolerance.invalidate(),
        utils.account.listSalvageQuarantine.invalidate(),
      ]);
      const toast = salvageLevelToast(next);
      pushToast({
        tone: 'info',
        title: toast.title,
        detail:
          next === 0
            ? `${toast.detail}（已释放 ${result.closedSalvage} 条宽容连接）`
            : toast.detail,
      });
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '设置失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const retryQuarantine = async (dbName?: string, table?: string): Promise<void> => {
    try {
      const result = await clearQuarantine.mutateAsync({
        ...(dbName ? { dbName } : {}),
        ...(table ? { table } : {}),
      });
      await utils.account.listSalvageQuarantine.invalidate();
      pushToast({
        tone: 'info',
        title: '已让它重新尝试读取',
        detail:
          result.cleared === 0
            ? '没有需要清除的隔离记录（可能已自动过期）。'
            : `清除了 ${result.cleared} 条隔离记录，下次读取会重新尝试；仍读不动的话会被再次隔离。`,
      });
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '清除隔离记录失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const changeReminder = async (remind: boolean): Promise<void> => {
    try {
      await setReminder.mutateAsync({ suppressed: !remind });
      await settings.refetch();
      pushToast({
        tone: 'info',
        title: remind ? '已开启数据库损坏提醒' : '已关闭数据库损坏提醒',
        detail: remind
          ? '以后健康检查确认数据库损坏时会弹窗提醒（主按钮就是「尝试修复」）。'
          : '以后不再弹窗；问题仍会写进日志并生成检查报告。',
      });
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '设置失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const busy = setLevel.isPending;
  const selectedCopy = salvageLevelCopy(pendingLossy ?? level);

  const content = (
    <div className="weq-set">
      {!embedded && (
        <SectionHeader
          title={page === 'policy' ? '数据库容错' : page === 'damage' ? '损坏与修复' : '容错记录'}
          icon={<DatabaseZap size={16} strokeWidth={1.9} />}
          desc={
            page === 'damage' ? undefined : (
              <>
                <span className="weq-set-exp-badge" title={SALVAGE_EXPERIMENTAL_NOTE}>
                  <FlaskConical size={11} strokeWidth={2.2} aria-hidden />
                  {SALVAGE_EXPERIMENTAL_TAG}
                </span>
              </>
            )
          }
        />
      )}

      {(page === 'policy' || embedded) && (
        <ToleranceGroup
          embedded={embedded}
          scope="当前账号"
          settingId="db-tolerance"
          title="容错级别"
          icon={<ShieldCheck size={15} strokeWidth={1.8} />}
          action={
            <select
              className="weq-set-input weq-database-tolerance-select"
              aria-label="数据库容错级别"
              value={tolerance.data ? String(pendingLossy ?? level) : ''}
              disabled={busy || !tolerance.data}
              onChange={(event) => {
                const next = salvageLevelsAscending().find(
                  (copy) => String(copy.level) === event.currentTarget.value,
                );
                if (!next || busy || !tolerance.data) return;
                if (next.level === level) setPendingLossy(null);
                else if (next.losesData) setPendingLossy(next.level);
                else void changeLevel(next.level);
              }}
            >
              {!tolerance.data && (
                <option value="">{tolerance.error ? '读取失败' : '状态待确认'}</option>
              )}
              {salvageLevelsAscending().map((copy) => (
                <option key={copy.level} value={copy.level}>
                  {copy.title}
                </option>
              ))}
            </select>
          }
        >
          {tolerance.data && selectedCopy.level > 0 && (
            <p className="weq-set-note">{selectedCopy.summary}</p>
          )}
          {tolerance.error && (
            <QueryError
              message="容错级别读取失败"
              retryLabel="重新读取容错级别"
              retrying={tolerance.isFetching}
              onRetry={() => void tolerance.refetch()}
            />
          )}
          {pendingLossy !== null && (
            <div className="weq-set-confirm" role="group" aria-live="polite">
              <span className="weq-set-confirm-text">
                <AlertTriangle size={12} strokeWidth={1.9} aria-hidden />
                <span>
                  {selectedCopy.confirm} {SALVAGE_EXPERIMENTAL_NOTE}
                </span>
              </span>
              <span className="weq-set-confirm-actions">
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-sm"
                  disabled={busy}
                  onClick={() => void changeLevel(pendingLossy)}
                >
                  确认启用级别 {pendingLossy}
                </button>
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                  disabled={busy}
                  onClick={() => setPendingLossy(null)}
                >
                  取消
                </button>
              </span>
            </div>
          )}
          <details className="weq-set-details">
            <summary>
              <ChevronDown size={13} aria-hidden />
              作用范围与代价
            </summary>
            <div className="weq-set-details-body">
              <dl className="weq-database-tolerance-scopes">
                {salvageLevelsAscending().map((copy) => (
                  <div key={copy.level}>
                    <dt>{copy.title}</dt>
                    <dd>{copy.scope}</dd>
                  </div>
                ))}
              </dl>
              <p>{SALVAGE_EXPERIMENTAL_NOTE}</p>
              <p className="weq-set-warnbox">
                <AlertTriangle size={12} strokeWidth={1.9} aria-hidden />
                <span>{SALVAGE_AGGREGATE_CAVEAT}</span>
              </p>
              {grantedAt && <p>授权时间：{eventTimeFormatter.format(new Date(grantedAt))}</p>}
            </div>
          </details>
        </ToleranceGroup>
      )}
      {(page === 'damage' || embedded) && (
        <ToleranceGroup
          embedded={embedded}
          icon={<AlertTriangle size={15} strokeWidth={1.8} />}
          settingId="damage-reminder"
        >
          <Row
            label="数据库异常时弹窗提醒"
            control={
              <Toggle
                checked={remindOnDamage}
                disabled={!settings.data || setReminder.isPending}
                onChange={(next) => void changeReminder(next)}
                label="数据库异常时弹窗提醒"
              />
            }
          />
        </ToleranceGroup>
      )}
      {(page === 'policy' || embedded) && onOpenRecords && (
        <ToleranceGroup
          embedded={embedded}
          title="当前账号容错记录"
          icon={<ScrollText size={15} strokeWidth={1.8} />}
          settingId="tolerance-records"
          action={
            <>
              <span className="weq-database-record-count" role="status">
                {summary
                  ? `${summary.total} 次 · ${quarantine.data ? `${quarantined.length} 表隔离` : quarantine.error ? '隔离状态读取失败' : '隔离状态读取中'}`
                  : tolerance.error
                    ? '读取失败'
                    : '待确认'}
              </span>
              <button
                type="button"
                className="weq-set-iconbtn"
                title="查看容错记录"
                aria-label="查看记录"
                onClick={onOpenRecords}
              >
                <ChevronRight size={16} aria-hidden />
              </button>
            </>
          }
        />
      )}
      {page === 'status' && (
        <Card
          title="降级账本"
          icon={<DatabaseZap size={15} strokeWidth={1.8} />}
          action={
            tolerance.error ? (
              <button
                type="button"
                className={`weq-set-iconbtn${tolerance.isFetching ? ' is-spinning' : ''}`}
                onClick={() => void utils.account.getDbTolerance.invalidate()}
                disabled={tolerance.isFetching}
                title="重试读取账本"
                aria-label="重试读取账本"
              >
                <RefreshCw size={14} strokeWidth={1.9} aria-hidden />
              </button>
            ) : undefined
          }
        >
          {hasLedger && summary ? (
            <p className="weq-set-desc">
              共 {summary.total} 次：换了访问路径（未丢数据） {summary.indexRetreat} 次 · 跳过区间{' '}
              {summary.skipped} 次 · 读不出来 {summary.unrecoverable} 次 · 放弃整表{' '}
              {summary.quarantined} 次{summary.lastAt ? ` · 最近 ${shortTime(summary.lastAt)}` : ''}
            </p>
          ) : (
            <p className="weq-set-desc">
              {tolerance.error
                ? '容错记录读取失败。'
                : tolerance.isLoading
                  ? '正在读取容错记录…'
                  : tolerance.data
                    ? '暂无容错记录。'
                    : '容错记录状态待确认。'}
            </p>
          )}
          {hasLedger &&
          summary &&
          summary.skipped + summary.unrecoverable + summary.quarantined > 0 ? (
            <details className="weq-set-details">
              <summary>
                <ChevronDown size={12} aria-hidden />
                「少数据」是什么意思
              </summary>
              <div className="weq-set-details-body">
                <p>{SALVAGE_SKIPPED_SPAN_CAVEAT}</p>
              </div>
            </details>
          ) : null}
          {entries.length > 0 ? (
            <ul className="weq-set-ledger">
              {entries.map((entry, index) => {
                const kind = LEDGER_KINDS[entry.kind] ?? LEDGER_KINDS.unrecoverable;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 账本按时间倒序渲染，同一毫秒可能重复
                  <li key={`${entry.at}:${index}`}>
                    <span className="weq-set-ledger-meta">
                      <span className="weq-set-mono">{shortTime(entry.at)}</span>
                      <span>{baseName(entry.dbPath)}</span>
                      <span
                        className={`weq-set-badge${kind.losesData ? ' weq-set-badge-warn' : ''}`}
                        title={kind.hint}
                      >
                        {kind.label}
                      </span>
                      {entry.errorCode != null ? (
                        <span className="weq-set-mono">SQLite {entry.errorCode}</span>
                      ) : null}
                    </span>
                    {entry.kind === 'skipped-ranges' && entry.message ? (
                      <span className="weq-set-note">
                        <span>{entry.message}</span>
                        {entry.skippedRangeCount != null ? (
                          <span className="weq-set-mono">
                            {entry.skippedRangeCount} 处 · 键跨度 {entry.skippedSpanUpperBound ?? 0}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    <span className="weq-set-mono">{entry.sqlFingerprint}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Card>
      )}

      {page === 'status' && quarantined.length > 0 ? (
        <Card
          title="已放弃的表（隔离中）"
          icon={<Table2 size={15} strokeWidth={1.8} />}
          action={
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm"
              disabled={clearQuarantine.isPending}
              onClick={() => void retryQuarantine()}
            >
              <RefreshCw size={13} aria-hidden="true" />
              全部再试一次
            </button>
          }
        >
          <p className="weq-set-desc">这些表连续读不动，已被暂时放弃（级别 3）；到点会自动重试。</p>
          <details className="weq-set-details">
            <summary>
              <ChevronDown size={12} aria-hidden />
              隔离是什么意思
            </summary>
            <div className="weq-set-details-body">
              <p>
                隔离是暂时的：到点会自动重试，你也可以用上面的按钮现在就让它们重新试一次。
                注意隔离的判据是<strong>整张表</strong>
                ，同一张表里本来完好的部分在隔离期内也读不出来。
              </p>
            </div>
          </details>
          <ul className="weq-set-ledger">
            {quarantined.map((entry) => (
              <li key={`${entry.dbPath}:${entry.table}`}>
                <span className="weq-set-ledger-meta">
                  <span className="weq-set-mono">{entry.table}</span>
                  <span>{baseName(entry.dbPath)}</span>
                  <span className="weq-set-badge weq-set-badge-warn">已放弃</span>
                  <span className="weq-set-mono">
                    连续失败 {entry.failures} 次 ·{' '}
                    {shortTime(new Date(entry.since * 1000).toISOString())}
                  </span>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-sm weq-set-btn-soft"
                    disabled={clearQuarantine.isPending}
                    onClick={() => void retryQuarantine(baseName(entry.dbPath), entry.table)}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    再试一次
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
  return embedded ? (
    <Card title="容错与修复" icon={<DatabaseZap size={15} />} resetId="db-tolerance">
      {content}
      {repairAction}
    </Card>
  ) : (
    content
  );
}
