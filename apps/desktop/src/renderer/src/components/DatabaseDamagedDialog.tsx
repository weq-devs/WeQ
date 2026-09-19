/**
 * 数据库损坏弹窗。
 *
 * 与旧版的区别：
 *   - 不再强制退回 bootstrap —— 健康检查确认损坏后只弹窗提示，用户可继续使用；
 *   - **不再在弹窗里直接开启宽容级别**。这里曾经有两个"顺手开一下"的按钮
 *     （换访问路径 / 忽略损坏继续使用），问题有三：
 *       1. 宽容是**实验性**的，覆盖范围很窄（只有导出这类按键轴分块的读取），
 *          在一个"出事了"的弹窗里顺手开启，用户没有机会看到代价与边界；
 *       2. 会丢数据的级别被塞进两个小按钮（还要点两次），和"确认一个会损失数据的
 *          选项"应有的分量不匹配；
 *       3. 级别 3 与账本、隔离清单都在设置页，弹窗里给出半套入口反而让人以为
 *          "开了就没事了"。
 *     现在这里只提供**一个**出口：去 设置 → 数据库宽容 自己挑，那里有完整代价说明
 *     与账本。口径文案统一来自 `@weq/service` 的 `db_tolerance_copy.ts`。
 *
 * TODO(修复入口)：将来会有独立的"
 * 数据库修复"页（页级替换 / 摘除坏页 + 重建受影响索引）。到那时这个弹窗应当再加一个
 * "尝试修复"的按钮，直接跳到那一页 —— 现在不放假按钮，只在正文里说明修复路径。
 */

import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import {
  BellOff,
  ChevronDown,
  ChevronRight,
  MessageCircle,
  Settings2,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  SALVAGE_AGGREGATE_CAVEAT,
  SALVAGE_EXPERIMENTAL_NOTE,
  SALVAGE_EXPERIMENTAL_TAG,
  SALVAGE_SKIPPED_SPAN_CAVEAT,
} from '@weq/service/db-tolerance-copy';
import { Modal } from './Dialog';
import { useToast } from './Toast';
import { client } from '../trpc/client';

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
}: {
  event: DatabaseDamagedEvent | null;
  onClose: () => void;
  /** 打开设置并落到指定分区。宽容级别只能由用户在设置页里自己选。 */
  onOpenSettings: (section: DatabaseDamageSettingsSection) => void;
}): ReactElement | null {
  const pushToast = useToast((s) => s.push);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  if (!event) return null;

  const isCheckError = event.kind === 'check-error';

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
                想继续使用，请到 <strong>设置 → 数据库宽容</strong> 自己选择容错级别
                <span className="weq-set-exp-badge">{SALVAGE_EXPERIMENTAL_TAG}</span>
                —— 这一屏只负责提醒，不在这里开启：能开到哪一级、会付出什么代价，
                需要你在设置页里看清楚再决定。{SALVAGE_EXPERIMENTAL_NOTE}
              </p>
            ) : null}
            {!isCheckError ? (
              <p>
                {SALVAGE_AGGREGATE_CAVEAT} 具体跳过/降级过什么，都会记在 设置 → 数据库宽容
                的账本里；{SALVAGE_SKIPPED_SPAN_CAVEAT}
              </p>
            ) : null}
            <p>
              真正恢复数据要靠<strong>修复数据库</strong>（按下面的方案手工处理，或将来的 WeQ
              修复入口）—— 容错只保证"少读一点也能用"，不负责把坏掉的内容找回来。
            </p>
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
