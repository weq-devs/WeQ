/**
 * 设置 → 数据库宽容（salvage）。
 *
 * 这一屏要回答三个问题，顺序也就是版面顺序：
 *   1. **现在是什么级别**（顶部一处说清，含"实验性"与覆盖范围）；
 *   2. **想开哪一级，代价是什么**（每一级一行，确认**就在那一行里**完成）；
 *   3. **到底降级过什么**（账本、隔离清单、坏页扫描）。
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
 * 版面注意：坏页扫描的库选择、账本、扫描报告都是"内容驱动宽度"的块，**不能**放进
 * `Row` 的右侧控件位（`.weq-set-row-ctrl` 是 `flex: none`，宽度跟着内容走，库名一多
 * 就顶破卡片边框）。它们统一用 `.weq-set-block` / `.weq-set-chips` 单独占一整行。
 *
 * 后端契约（account router）：
 *   - getDbTolerance           — { level, grantedAt, summary, entries }
 *   - setDbToleranceLevel      — { level, source? } → { level, grantedAt, closedSalvage }
 *   - scanDatabaseBadPages     — { dbName } → 坏页清单 + 受影响的表/索引
 */

import { useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  DatabaseZap,
  FlaskConical,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
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
import { Card, SectionHeader } from './controls';

/** 可扫描坏页的数据库（与后端 `ACCOUNT_HEALTH_DATABASES` 白名单保持一致）。 */
const SCANNABLE_DATABASES = [
  'nt_msg.db',
  'group_info.db',
  'profile_info.db',
  'emoji.db',
  'misc.db',
  'group_msg_fts.db',
  'buddy_msg_fts.db',
  'files_in_chat.db',
  'file_assistant.db',
] as const;

/** 页号清单是一次性给全还是截断显示（后端会把整份清单给过来）。 */
const BAD_PAGE_PREVIEW = 40;

/** `BadPageScanReport` 的渲染层视图（与 account router 的返回对齐）。 */
interface BadPageReport {
  dbName: string;
  dbPath: string;
  pageSize: number;
  pageCount: number;
  badPages: number[];
  zeroPages: number[];
  /** QQ 头之后就是明文 SQLite（没有加密）：坏页地图对它没有意义。 */
  plaintext: boolean;
  trailingBytes: number;
  usedHmac: boolean;
  headerOffset: number;
  affected: Array<{ name: string; pagetype: string; badPageCount: number; samplePages: number[] }>;
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
  const scan = trpc.account.scanDatabaseBadPages.useMutation();
  const quarantine = trpc.account.listSalvageQuarantine.useQuery(undefined, { staleTime: 5000 });
  const clearQuarantine = trpc.account.clearSalvageQuarantine.useMutation();

  const [scanTarget, setScanTarget] = useState<string>('nt_msg.db');
  const [report, setReport] = useState<BadPageReport | null>(null);
  /** 正在等用户确认的**那个**级别；确认条就渲染在这一行里面。 */
  const [pendingLossy, setPendingLossy] = useState<number | null>(null);

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

  const runScan = async (): Promise<void> => {
    setReport(null);
    try {
      const result = await scan.mutateAsync({ dbName: scanTarget });
      setReport(result as BadPageReport);
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '坏页扫描失败',
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
            到点会自动重试，你也可以现在就让它们重新试一次。注意隔离的判据是**整张表**，
            同一张表里本来完好的部分在隔离期内也读不出来。
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

      <Card
        title="坏页扫描"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-sm"
            disabled={scan.isPending}
            onClick={() => void runScan()}
          >
            {scan.isPending ? (
              <Loader2 size={12} strokeWidth={2} className="weq-spin" aria-hidden />
            ) : (
              <Stethoscope size={12} strokeWidth={2} aria-hidden />
            )}
            {scan.isPending ? '扫描中…' : '开始扫描'}
          </button>
        }
      >
        <div className="weq-set-block">
          <span className="weq-set-row-label">目标数据库</span>
          <div className="weq-set-chips" role="radiogroup" aria-label="坏页扫描的目标数据库">
            {SCANNABLE_DATABASES.map((name) => {
              const active = name === scanTarget;
              return (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`weq-set-btn weq-set-btn-sm${active ? '' : ' weq-set-btn-soft'}`}
                  disabled={scan.isPending}
                  onClick={() => {
                    setScanTarget(name);
                    setReport(null);
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <span className="weq-set-row-desc">
            按 SQLCipher 的页布局逐页复算 HMAC，给出物理坏页清单，并映射到受影响的表 / 索引。
            只读密文，不会修改数据库。想真修复请等修复入口，或按损坏弹窗里的方案手工处理。
          </span>
        </div>

        {report ? (
          <div className="weq-set-kv">
            {report.usedHmac ? (
              <>
                <span>
                  <strong>{report.dbName}</strong> 共 {report.pageCount} 页（每页 {report.pageSize}{' '}
                  字节）
                  {report.zeroPages.length > 0 ? `，全零页 ${report.zeroPages.length} 个` : ''}
                  {report.trailingBytes > 0 ? `，文件尾残余 ${report.trailingBytes} 字节` : ''}。
                </span>
                {report.badPages.length === 0 ? (
                  <span className="weq-set-ok">没有发现坏页 —— 页层面是完好的。</span>
                ) : (
                  <>
                    <span>
                      坏页 <strong>{report.badPages.length}</strong> 个
                      {report.badPages.length > BAD_PAGE_PREVIEW
                        ? `（下列只显示前 ${BAD_PAGE_PREVIEW} 个）`
                        : ''}
                      ：
                    </span>
                    <span className="weq-set-mono">
                      {report.badPages.slice(0, BAD_PAGE_PREVIEW).join(', ')}
                    </span>
                    {report.affected.length > 0 ? (
                      <ul>
                        {report.affected.map((item) => (
                          <li key={`${item.name}:${item.pagetype}`}>
                            <span className="weq-set-mono">{item.name}</span>（{item.pagetype}）命中{' '}
                            {item.badPageCount} 个坏页
                            {item.samplePages.length > 0
                              ? ` · 例如 ${item.samplePages.slice(0, 5).join(', ')}`
                              : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span>
                        坏页未能映射到具体对象（dbstat 不可用或数据库损坏过重），页号清单仍有效。
                      </span>
                    )}
                  </>
                )}
              </>
            ) : report.plaintext ? (
              <span>
                这是一个<strong>明文</strong>数据库：没有 salt、没有页 HMAC，逐页校验无从做起 ——
                这类库（例如经过解密的镜像）请直接用普通查询或完整性检查，坏页地图对它 没有意义。
              </span>
            ) : (
              <span>
                这个数据库没有开启页 HMAC，逐页校验无从做起 —— <strong>这不代表数据库是好的</strong>
                ，只是这套地图在这里没有意义。
              </span>
            )}
            <span>
              扫描位置：<span className="weq-set-mono">{report.dbPath}</span>
            </span>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
