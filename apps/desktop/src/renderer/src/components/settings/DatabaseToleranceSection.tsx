/**
 * 设置 → 数据库宽容（salvage）。
 *
 * 这一屏要回答三个问题，顺序也就是版面顺序：
 *   1. **现在是什么级别**（顶部一处说清，含"实验性"与覆盖范围）；
 *   2. **想开哪一级，代价是什么**（每一级一行，确认**就在那一行里**完成）；
 *   3. **到底降级过什么**（账本、隔离清单）。
 *
 * 坏页扫描**不在这里**：它已经搬到 妙妙工具 → 数据库修复（那边才对**任意账号**
 * 可用，且与修复共用同一份实现）。这里只留容错本身的账。
 *
 * 三条不变量，界面文案必须与之保持一致：
 *   1. **默认严格**：级别 0 是默认，也占一行，用户随时能看到"关掉会回到什么"。
 *   2. **会丢数据的级别必须当场确认**：确认框内联在被点的那一行里 ——
 *      曾经放在卡片底部，结果点级别 1 的开关时确认条出现在级别 3 下面，位置与
 *      操作对象对不上。现在确认与它在同一行，且带 `aria-live` 提示。
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

import { useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  DatabaseZap,
  FlaskConical,
  Info,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  SALVAGE_AGGREGATE_CAVEAT,
  SALVAGE_EXPERIMENTAL_NOTE,
  SALVAGE_EXPERIMENTAL_TAG,
  SALVAGE_SKIPPED_SPAN_CAVEAT,
  salvageLevelCopy,
  salvageLevelToast,
  salvageLevelsAscending,
} from '@weq/service/db-tolerance-copy';
import { trpc } from '../../trpc/client';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';

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

/** `2026-09-19T03:04:05.678Z` → `09-19 03:04`（本机时区）。 */
function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function DatabaseToleranceSection(): ReactElement {
  const pushToast = useToast((s) => s.push);
  const utils = trpc.useUtils();
  const tolerance = trpc.account.getDbTolerance.useQuery(undefined, { staleTime: 5000 });
  const setLevel = trpc.account.setDbToleranceLevel.useMutation();
  const quarantine = trpc.account.listSalvageQuarantine.useQuery(undefined, { staleTime: 5000 });
  const clearQuarantine = trpc.account.clearSalvageQuarantine.useMutation();

  /** 正在等用户确认的**那个**级别；确认条就渲染在这一行里面。 */
  const [pendingLossy, setPendingLossy] = useState<number | null>(null);
  // 弹窗提醒开关。它存在 AppSettings 里（不是宽容级别那一套），所以单独查一次。
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
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
  const current = salvageLevelCopy(level);

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

  return (
    <div className="weq-set">
      <SectionHeader
        title="数据库宽容"
        icon={<DatabaseZap size={16} strokeWidth={1.9} />}
        desc={
          <>
            <span className="weq-set-exp-badge" title={SALVAGE_EXPERIMENTAL_NOTE}>
              <FlaskConical size={11} strokeWidth={2.2} aria-hidden />
              {SALVAGE_EXPERIMENTAL_TAG}
            </span>
            QQ 数据库损坏时，默认（级别 0 · 严格）会让相关查询直接报错。严格之外还有三级宽容： 级别
            1 只换访问路径（<strong>不丢数据</strong>），级别 2 会跳过读不出来的区间（
            <strong>可能缺失部分消息</strong>），级别 3 再允许放弃读不动的整张表。
            {SALVAGE_EXPERIMENTAL_NOTE}
          </>
        }
      />

      {/* 提醒是弹窗那条路的总开关：关掉之后，损坏只会进日志与检查报告，不会找人。
          放在这里是因为它和宽容级别回答的是同一个问题（"库坏了之后会怎样"）。 */}
      <Card title="损坏提醒">
        <Row
          label="数据库异常时弹窗提醒"
          desc="健康检查确认损坏后才会弹窗（主按钮为「尝试修复」，也可以从妙妙工具 → 数据库修复手动进入）。关掉后仍会写日志并生成检查报告 —— 需要时随时可以在这里再打开。"
          control={
            <Toggle
              checked={remindOnDamage}
              disabled={!settings.data || setReminder.isPending}
              onChange={(next) => void changeReminder(next)}
              label="数据库异常时弹窗提醒"
            />
          }
        />
      </Card>

      <Card
        title="宽容级别"
        action={
          <span className="weq-set-badge weq-set-badge-ok" title={current.scope}>
            当前 · {current.title}
          </span>
        }
      >
        <p className="weq-set-warnbox">
          <AlertTriangle size={12} strokeWidth={1.9} aria-hidden />
          <span>{SALVAGE_AGGREGATE_CAVEAT}</span>
        </p>
        <div className="weq-set-levels" role="radiogroup" aria-label="数据库宽容级别">
          {salvageLevelsAscending().map((copy) => {
            const active = copy.level === level;
            const confirming = pendingLossy === copy.level;
            return (
              <div
                key={copy.level}
                className={`weq-set-level${active ? ' is-active' : ''}${confirming ? ' is-confirming' : ''}`}
              >
                <div className="weq-set-level-head">
                  <span className="weq-set-level-main">
                    <span className="weq-set-level-title">
                      {copy.title}
                      {active ? <span className="weq-set-level-tag">当前</span> : null}
                    </span>
                    <span className="weq-set-level-desc">{copy.summary}</span>
                    <span className="weq-set-level-desc">{copy.scope}</span>
                    {copy.losesData ? (
                      <span className="weq-set-level-loss">
                        <AlertTriangle size={11} strokeWidth={1.9} aria-hidden />
                        会少数据
                      </span>
                    ) : null}
                  </span>
                  <span className="weq-set-level-action">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`weq-set-btn weq-set-btn-sm${active ? '' : ' weq-set-btn-soft'}`}
                      disabled={busy || active}
                      onClick={() => {
                        if (active) return;
                        if (copy.losesData) {
                          setPendingLossy(copy.level);
                          return;
                        }
                        void changeLevel(copy.level);
                      }}
                    >
                      {active ? '已启用' : copy.level === 0 ? '恢复严格' : `启用级别 ${copy.level}`}
                    </button>
                  </span>
                </div>
                {confirming ? (
                  <div className="weq-set-confirm" role="group" aria-live="polite">
                    <span className="weq-set-confirm-text">
                      <AlertTriangle size={12} strokeWidth={1.9} aria-hidden />
                      <span>
                        {copy.confirm} {SALVAGE_EXPERIMENTAL_NOTE}
                      </span>
                    </span>
                    <span className="weq-set-confirm-actions">
                      <button
                        type="button"
                        className="weq-set-btn weq-set-btn-sm"
                        disabled={busy}
                        onClick={() => void changeLevel(copy.level)}
                      >
                        确认启用级别 {copy.level}
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
                ) : null}
              </div>
            );
          })}
        </div>
        {level >= 1 && grantedAt ? (
          <p className="weq-set-note">
            <ShieldCheck size={12} strokeWidth={1.9} aria-hidden />
            <span>
              已于 {new Date(grantedAt).toLocaleString()} 授权，在本机对该账号持续生效；
              随时可以在这里回到级别 0。
            </span>
          </p>
        ) : (
          <p className="weq-set-note">
            <Info size={12} strokeWidth={1.9} aria-hidden />
            <span>
              默认严格模式：损坏时照常报错，不会静默降级。开启后的每一次降级都会记在下面的账本里。
            </span>
          </p>
        )}
      </Card>

      <Card
        title="降级账本"
        action={
          <button
            type="button"
            className={`weq-set-iconbtn${tolerance.isFetching ? ' is-spinning' : ''}`}
            onClick={() => void utils.account.getDbTolerance.invalidate()}
            disabled={tolerance.isFetching}
            title="刷新账本"
            aria-label="刷新账本"
          >
            <RefreshCw size={14} strokeWidth={1.9} aria-hidden />
          </button>
        }
      >
        {hasLedger && summary ? (
          <p className="weq-set-desc">
            共 {summary.total} 次：换了访问路径（未丢数据） {summary.indexRetreat} 次 · 跳过区间{' '}
            {summary.skipped} 次 · 读不出来 {summary.unrecoverable} 次 · 放弃整表{' '}
            {summary.quarantined} 次{summary.lastAt ? ` · 最近 ${shortTime(summary.lastAt)}` : ''}
            {summary.skipped > 0 || summary.unrecoverable > 0 || summary.quarantined > 0
              ? `（带“少数据”的条目意味着确实有内容没读出来。${SALVAGE_SKIPPED_SPAN_CAVEAT}）`
              : ''}
          </p>
        ) : (
          <p className="weq-set-desc">
            还没有任何降级记录。只有在你开启了宽容模式、且真的遇到损坏时才会产生记录。
          </p>
        )}
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

      {quarantined.length > 0 ? (
        <Card
          title="已放弃的表（隔离中）"
          action={
            <button
              type="button"
              className="weq-set-btn weq-set-btn-sm"
              disabled={clearQuarantine.isPending}
              onClick={() => void retryQuarantine()}
            >
              全部再试一次
            </button>
          }
        >
          <p className="weq-set-desc">
            这些表连续多少次都读不动，已被理解成"暂时不可用"（级别 3）。隔离只是暂时的：
            到点会自动重试，你也可以现在就让它们重新试一次。注意隔离的判据是
            <strong>整张表</strong>，同一张表里本来完好的部分在隔离期内也读不出来。
          </p>
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
}
