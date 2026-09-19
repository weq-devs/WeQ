/**
 * 数据库损坏弹窗。
 *
 * 与旧版的区别：不再强制退回 bootstrap —— 健康检查确认损坏后只弹窗提示，
 * 用户可继续使用。弹窗内提供：
 *   - 修复方案（默认折叠，内容较多可展开）
 *   - 检测详情（默认折叠）
 *   - 反馈问题：下拉选 GitHub Issue / QQ 交流群，点击后由主进程把今天的
 *     日志 + settings.db + 密钥算法配置 + 检查报告打包到缓存目录，并打开
 *     文件夹与对应网页 / QQ 深链接。
 */

import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  BellOff,
  ChevronDown,
  ChevronRight,
  MessageCircle,
  ShieldAlert,
  TriangleAlert,
  Waypoints,
  X,
} from 'lucide-react';
import { Modal } from './Dialog';
import { useToast } from './Toast';
import { client, trpc } from '../trpc/client';

/** 与主进程 `AccountForcedClosedEvent` 对齐的渲染层视图。 */
export interface DatabaseDamagedEvent {
  reason: 'database-damaged';
  kind: 'confirmed' | 'check-error';
  title: string;
  message: string;
  details: string[];
  failures: Array<{
    dbName: string;
    dbPath: string;
    corruptedTables: string[];
    error?: string;
  }>;
  reportPath: string | null;
}

function ExpandSection({
  title,
  children,
  defaultOpen = false,
  className,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`weq-db-damaged-section ${className ?? ''}`}>
      <button type="button" className="weq-db-expand-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? (
          <ChevronDown size={14} strokeWidth={2.4} />
        ) : (
          <ChevronRight size={14} strokeWidth={2.4} />
        )}
        <span>{title}</span>
      </button>
      {open ? <div className="weq-db-expand-body">{children}</div> : null}
    </section>
  );
}

export function DatabaseDamagedDialog({
  event,
  onClose,
}: {
  event: DatabaseDamagedEvent | null;
  onClose: () => void;
}): ReactElement | null {
  const pushToast = useToast((s) => s.push);
  const utils = trpc.useUtils();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 会丢数据的授权要点两次：第一次只是把后果摆出来（不新增样式类）。 */
  const [lossyArmed, setLossyArmed] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 只在弹窗打开期间查一次当前宽容级别，用来決定“授权”按钮是否还能点。
  const tolerance = trpc.account.getDbTolerance.useQuery(undefined, { staleTime: 5000 });

  if (!event) return null;

  const isCheckError = event.kind === 'check-error';
  const salvageLevel = tolerance.data?.level ?? 0;

  /**
   * 用户显式授权“损坏时换一条访问路径重试”。
   *
   * 这是本弹窗与设置页之外的第三个入口，共同点只有一个：**必须由用户点**。
   * 这里提供两档：级别 1（换访问路径，不丢数据）与级别 2（跳过坏页，会丢数据）。级别 2
   * 必须**点两次**（第一次只是把后果摆出来），因为它是唯一会让导出少消息的选项；级别 3
   * （放弃整表）不在弹窗里提供 —— 那一步应该由用户看清楚隔离清单后在设置页决定。
   */
  const enableSalvage = async (nextLevel: number): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await client.account.setDbToleranceLevel.mutate({
        level: nextLevel,
        source: 'damage-dialog',
      });
      await utils.account.getDbTolerance.invalidate();
      pushToast({
        tone: 'info',
        title: `已开启数据库宽容模式（级别 ${result.level}）`,
        detail:
          nextLevel >= 2
            ? '导出时读不出来的区间会被跳过（可能缺失部分消息），明细可在 设置 → 数据库宽容 的账本里核对。放好数据库备份后建议修复一次。'
            : '损坏时对于只有索引受损的查询会改走整表扫描，数据不会丢，个别查询可能变慢。每次降级都会记入账本：设置 → 数据库宽容。',
      });
      onClose();
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '开启失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  /** 「不再提醒」：写入全局配置后关闭弹窗（✕ 只关闭本次，不写入）。 */
  const suppressReminder = async (): Promise<void> => {
    try {
      await client.bootstrap.setSuppressDbDamageReminder.mutate({ suppressed: true });
      pushToast({
        tone: 'info',
        title: '已不再提醒数据库损坏弹窗',
        detail: '之后数据库异常时不会再自动弹出该提醒。',
      });
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '设置失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    onClose();
  };

  const reportFeedback = async (target: 'github' | 'qqgroup'): Promise<void> => {
    setMenuOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      const result = await client.account.collectDbDamageFeedback.mutate({ target });
      if (!result.ok) {
        pushToast({ tone: 'error', title: '反馈打包失败', detail: result.errors?.join('\n') });
        return;
      }
      const parts: string[] = [];
      if (result.errors && result.errors.length > 0) {
        parts.push(`部分文件未打包：${result.errors.join('；')}`);
      }
      if (result.openError) parts.push(result.openError);
      pushToast({
        tone: 'info',
        title: '已打包反馈文件并打开文件夹',
        detail: result.folder + (parts.length > 0 ? `\n${parts.join('\n')}` : ''),
      });
    } catch (e) {
      pushToast({
        tone: 'error',
        title: '反馈打包失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="weq-db-damaged-title" width={520}>
      <div className="weq-dialog weq-dialog-error weq-db-damaged">
        <div className="weq-dialog-head">
          <span className="weq-dialog-icon">
            <ShieldAlert size={20} strokeWidth={1.85} aria-hidden />
          </span>
          <h3 id="weq-db-damaged-title" className="weq-dialog-title">
            {event.title}
          </h3>
          <button className="weq-dialog-x" onClick={onClose} aria-label="关闭">
            <X size={16} strokeWidth={1.9} aria-hidden />
          </button>
        </div>

        <div className="weq-dialog-body weq-db-damaged-dialog">
          <section className="weq-db-damaged-section">
            <h4>发生了什么</h4>
            <p>{isCheckError ? '检测 QQ 数据库健康状态时发生错误。' : '检测到 QQ 数据库损坏。'}</p>
            <p>问题通常出在 QQ 数据库本身，不是 WeQ 软件导致。</p>
            {!isCheckError ? (
              <p>
                如果你希望即使有损坏也继续使用，可以开启下方的
                <strong>数据库宽容</strong>：只有索引受损的查询会改走整表扫描，
                <strong>不会丢数据</strong>，只是个别查询会变慢；每次降级都会记录在 设置 →
                数据库宽容 的账本里。
              </p>
            ) : null}
            {!isCheckError ? (
              <p>
                如果损坏已经让消息读不出来，还有一个更宽的选项
                <strong>「忽略损坏继续使用」</strong>：导出时读不出来的区间会被跳过， 能读多少读多少
                —— 代价是<strong>可能缺失部分消息</strong>。跳过的位置会写进
                导出结果与账本（行数只能给出上界）。要真正恢复数据仍建议按下面的方案修复。
              </p>
            ) : null}
          </section>

          <ExpandSection title="建议修复方案（可展开）">
            <ol className="weq-db-fix-steps">
              <li>
                移除 1024 字节自定义头（从第 1025 字节开始截取）：
                <pre className="weq-db-codeblock">
                  tail -c +1025 nt_msg.db &gt; nt_msg_stripped.db
                </pre>
              </li>
              <li>
                用 Windows 版 sqlcipher 解密并导出为 SQL 文件（密钥见反馈包
                <code> db_key_and_algos.json</code>）：
                <pre className="weq-db-codeblock">
                  {
                    'sqlcipher nt_msg_stripped.db\nPRAGMA key="<dbKey>";\nPRAGMA cipher_migrate;\n.output nt_msg.sql\n.dump'
                  }
                </pre>
              </li>
              <li>
                用 msys2 把 SQL 导入生成新的 db 文件（sed 会把出错中止的 ROLLBACK 改成
                COMMIT，自动跳过损坏的行）：
                <pre className="weq-db-codeblock">
                  {
                    "cat nt_msg.sql | sed -e 's|^ROLLBACK;\\( -- due to errors\\)*$|COMMIT;|g' | sqlite3 nt_msg.db"
                  }
                </pre>
              </li>
              <li>
                修复完成后，用 WeQ 的「静态目录」方案（首页 → 新的开始 → 静态目录）打开
                修复后的数据库目录继续使用。
              </li>
            </ol>
          </ExpandSection>

          <ExpandSection title="检测详情（可展开）" className="weq-db-damaged-details">
            {event.details.length > 0 ? (
              <ul>
                {event.details.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 列表按位置渲染,无稳定唯一键
                  <li key={`${line}:${index}`}>{line}</li>
                ))}
              </ul>
            ) : (
              <p>（无）</p>
            )}
            {event.reportPath ? (
              <p className="weq-db-report-path">检查报告：{event.reportPath}</p>
            ) : null}
          </ExpandSection>
        </div>

        <div className="weq-dialog-foot weq-db-damaged-foot">
          <div className="weq-db-feedback-wrap" ref={menuRef}>
            <button
              type="button"
              className="weq-action-soft"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={busy}
            >
              <MessageCircle size={13} strokeWidth={2} aria-hidden />
              反馈问题{busy ? '…' : ''}
            </button>
            {menuOpen ? (
              <div className="weq-db-feedback-menu">
                <button type="button" onClick={() => void reportFeedback('github')}>
                  GitHub Issue
                </button>
                <button type="button" onClick={() => void reportFeedback('qqgroup')}>
                  QQ 交流群
                </button>
              </div>
            ) : null}
          </div>
          {!isCheckError ? (
            <button
              type="button"
              className="weq-action-soft"
              disabled={busy || salvageLevel >= 1}
              title={
                salvageLevel >= 1
                  ? '数据库宽容模式已经开启，可在设置 → 数据库宽容 里调整'
                  : undefined
              }
              onClick={() => void enableSalvage(1)}
            >
              <Waypoints size={13} strokeWidth={2} aria-hidden />
              {salvageLevel >= 1 ? '宽容模式已开启' : '允许换访问路径重试'}
            </button>
          ) : null}
          {!isCheckError && salvageLevel < 2 ? (
            <button
              type="button"
              className="weq-action-soft"
              disabled={busy}
              title={
                lossyArmed ? '再点一次确认：可能缺失部分消息' : '会跳过读不出来的区间，可能缺失消息'
              }
              onClick={() => {
                if (!lossyArmed) {
                  setLossyArmed(true);
                  return;
                }
                void enableSalvage(2);
              }}
            >
              <TriangleAlert size={13} strokeWidth={2} aria-hidden />
              {lossyArmed ? '再点一次确认（可能缺失消息）' : '忽略损坏继续使用'}
            </button>
          ) : null}
          <button
            type="button"
            className="weq-action-primary"
            onClick={() => void suppressReminder()}
          >
            <BellOff size={13} strokeWidth={2} aria-hidden />
            不再提醒
          </button>
        </div>
      </div>
    </Modal>
  );
}
