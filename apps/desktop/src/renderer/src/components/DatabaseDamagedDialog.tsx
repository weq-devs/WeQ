/** 数据库检查详情与修复入口；跳过区间或表由对应任务单独询问。 */

import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  MessageCircle,
  Settings2,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-react';
import { Modal } from './Dialog';
import { useToast } from './Toast.shared';
import { client } from '../trpc/client';
import { isRemoteClient } from '../lib/remoteClient';
import { useSurfaceEscapeDismissal } from '../lib/surfaceEscape';
import { NotificationMethodSelect } from './settings/NotificationMethodSelect';

/** 与主进程 `AccountForcedClosedEvent` 对齐的渲染层视图。 */
export interface DatabaseDamagedEvent {
  reason: 'database-damaged';
  kind: 'confirmed' | 'check-error';
  /** 出问题的是哪个账号（直接拿它预选修复页上的账号）。 */
  uin: string;
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

/** 弹窗唯一会跳转的设置分区。 */
export type DatabaseDamageSettingsSection = 'database';

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
  onOpenSettings,
  onOpenRepair,
}: {
  event: DatabaseDamagedEvent | null;
  onClose: () => void;
  /** 打开设置并定位数据库检查与修复。 */
  onOpenSettings: (section: DatabaseDamageSettingsSection) => void;
  /** 打开设置 → 数据维护 → 维护工具 → 数据库修复，并预选出问题的那个账号。 */
  onOpenRepair: (uin: string) => void;
}): ReactElement | null {
  const pushToast = useToast((s) => s.push);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useSurfaceEscapeDismissal(menuRef, () => setMenuOpen(false), Boolean(event) && menuOpen);

  if (!event) return null;

  const isCheckError = event.kind === 'check-error';

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
        durationKind: parts.length ? 'failure' : 'success',
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
    <Modal onClose={onClose} dismissOnOutside={false} labelledBy="weq-db-damaged-title" width={520}>
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
            <p>
              {isCheckError
                ? '解密失败、数据源不匹配或文件尚未就绪都可能导致读取失败，不能据此认定文件损坏。请先核对数据源和密钥，不要直接修复或替换原库。'
                : '请保留原始文件并核对检查报告；仅凭此结果不能判断损坏由哪个程序或操作导致。'}
            </p>
            {!isCheckError ? (
              <p>
                可以尝试<strong>数据库修复</strong>，将仍可读取的内容重建到新库中。修复前会备份，
                但无法保证恢复全部数据。可从{' '}
                <strong>设置 → QQ → QQ 数据库管理 → 数据库检查与修复</strong>
                进入，也可以点击下方的「尝试修复」。
              </p>
            ) : null}
          </section>

          {!isCheckError && !isRemoteClient() && (
            <ExpandSection title="手工修复方案（备用，可展开）">
              <p>
                一般用不上：上面的「尝试修复」已经是同一条链（解密 → 重建 → 重新加密 → 补回
                文件头）的自动化版本。只有当修复也修不出来（例如坏得太重、要连库结构一起抢救）
                时，再走下面的手工路径。
              </p>
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
                  修复完成后，用 WeQ 的「导入备份」（账号主页 → 导入备份）打开
                  修复后的数据库目录继续使用。
                </li>
              </ol>
            </ExpandSection>
          )}

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
          <div className="weq-db-feedback-wrap">
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
              <div
                ref={menuRef}
                data-weq-escape-surface
                className="weq-db-feedback-menu"
                role="menu"
                aria-label="反馈问题"
              >
                <button type="button" onClick={() => void reportFeedback('github')}>
                  GitHub Issue
                </button>
                <button type="button" onClick={() => void reportFeedback('qqgroup')}>
                  QQ 交流群
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="weq-action-soft"
            onClick={() => {
              onClose();
              onOpenSettings('database');
            }}
          >
            <Settings2 size={13} strokeWidth={2} aria-hidden />
            打开设置
          </button>
          <div className="weq-db-damaged-notification">
            <span>异常提醒</span>
            <NotificationMethodSelect event="databaseDamage" />
          </div>
          {!isCheckError && (
            <button
              type="button"
              className="weq-action-primary"
              onClick={() => onOpenRepair(event.uin)}
            >
              <Wrench size={13} strokeWidth={2} aria-hidden />
              尝试修复
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
