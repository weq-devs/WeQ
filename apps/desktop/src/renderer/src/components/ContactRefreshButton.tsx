import { useEffect, useState } from 'react';
import { Database, RefreshCw, X } from 'lucide-react';
import { Modal, useDialog } from './Dialog';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { SegmentedControl } from './SegmentedControl';
import '../styles/contact-directory-order.css';

export function ContactRefreshButton({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={refreshing}
        aria-busy={refreshing}
        title={refreshing ? '正在刷新联系人' : '刷新联系人列表'}
        aria-label={refreshing ? '正在刷新联系人' : '刷新联系人列表'}
      >
        <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />
      </button>
      {open && <ContactCacheRefreshDialog onClose={() => setOpen(false)} onRefresh={onRefresh} />}
    </>
  );
}

export function ContactCacheRefreshDialog({
  onClose,
  onRefresh,
  stale = false,
}: {
  onClose: () => void;
  onRefresh?: () => void;
  stale?: boolean;
}) {
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: Boolean(uin),
  });
  const [range, setRange] = useState<'older24h' | 'all' | 'none'>('older24h');
  const storageKey = `weq.contacts.refreshRange.${config.data?.configId ?? ''}.${uin ?? ''}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === 'older24h' || saved === 'all' || saved === 'none') setRange(saved);
      else setRange('older24h');
    } catch {
      /* 使用默认更新范围。 */
    }
  }, [storageKey]);
  const rebuild = trpc.account.contactMetrics.rebuild.useMutation();
  const showError = useDialog((state) => state.showError);
  const start = async () => {
    if (range === 'none') {
      onClose();
      onRefresh?.();
      return;
    }
    if (!uin || config.data?.uin !== uin) return;
    const binding = { expectedAccountUin: uin, expectedAccountConfigId: config.data.configId };
    try {
      const taskId = await rebuild.mutateAsync({ ...binding, missingOnly: false, range });
      onClose();
      if (useViewState.getState().openedUin === uin) {
        onRefresh?.();
        if (onRefresh) {
          if (taskId) useWorkspaceMenu.getState().focusTask(`background:host:${taskId}`);
          else useWorkspaceMenu.getState().openTasks();
        }
      }
    } catch (error) {
      onClose();
      showError('缓存重建启动失败', error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Modal
      labelledBy="contact-refresh-title"
      centered
      onClose={onClose}
      width={440}
      className="weq-message-modal"
    >
      <div className="weq-dialog weq-dialog-info">
        <div className="weq-dialog-head">
          <span className="weq-dialog-icon">
            <RefreshCw size={20} aria-hidden />
          </span>
          <h3 id="contact-refresh-title" className="weq-dialog-title">
            {stale ? '更新联系人缓存' : '刷新联系人'}
          </h3>
          <button type="button" className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="weq-dialog-body">
          <p>
            {stale
              ? '该依据的缓存已超过 7 天或尚未建立，是否更新？'
              : '选择联系人排序与分组缓存的更新范围。'}
          </p>
          <SegmentedControl
            label="缓存更新范围"
            disabled={rebuild.isLoading}
            value={range}
            options={[
              { value: 'older24h', label: '超 24h 未更新' },
              { value: 'all', label: '全部' },
              { value: 'none', label: '不更新' },
            ]}
            onChange={(value) => {
              setRange(value);
              if (config.data?.uin === uin)
                try {
                  localStorage.setItem(storageKey, value);
                } catch {
                  /* 更新范围不影响操作。 */
                }
            }}
          />
          <dl className="weq-contact-refresh-help">
            <div>
              <dt>超 24h 未更新</dt>
              <dd>补齐缺失的缓存，并更新超过 24 小时未更新的缓存；最近更新的保留。</dd>
            </div>
            <div>
              <dt>全部</dt>
              <dd>重新计算所有好友与群聊的排序、分组缓存，不论上次更新时间。</dd>
            </div>
            <div>
              <dt>不更新</dt>
              <dd>继续使用现有缓存，不启动缓存更新任务；缺失或过期的数据保持原样。</dd>
            </div>
          </dl>
          {config.error && <p role="alert">账号信息读取失败：{config.error.message}</p>}
        </div>
        <div className="weq-dialog-foot weq-contact-refresh-actions">
          <button type="button" className="weq-action-soft" onClick={onClose}>
            <X size={14} />
            取消
          </button>
          <button
            type="button"
            className="weq-action-primary"
            aria-busy={rebuild.isLoading}
            disabled={rebuild.isLoading || (range !== 'none' && config.data?.uin !== uin)}
            onClick={() => void start()}
          >
            {range === 'none' ? <RefreshCw size={14} /> : <Database size={14} />}
            {onRefresh ? '刷新' : '确定'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
