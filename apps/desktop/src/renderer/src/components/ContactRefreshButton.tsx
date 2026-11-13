import { useEffect, useState } from 'react';
import { Database, RefreshCw, X } from 'lucide-react';
import { Modal, useDialog } from './Dialog';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { SegmentedControl } from './SegmentedControl';
import { useContactRefreshTask } from '../hooks/useContactRefreshTask';
import '../styles/contact-directory-order.css';
import type { ContactMetric } from '@weq/service';
import { PREFERENCES_CHANGED, changePreference, preferenceValue } from '../lib/clientPreferences';

export function ContactRefreshButton({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const task = useContactRefreshTask();
  const busy = refreshing || task.active;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (task.ready && !task.openActiveTask()) setOpen(true);
        }}
        disabled={!task.ready}
        aria-busy={busy}
        title={busy ? '查看好友/群信息缓存更新任务' : '更新好友/群信息缓存'}
        aria-label={busy ? '查看好友/群信息缓存更新任务' : '更新好友/群信息缓存'}
      >
        <RefreshCw size={15} className={busy ? 'spin' : undefined} />
      </button>
      {open && <ContactCacheRefreshDialog onClose={() => setOpen(false)} onRefresh={onRefresh} />}
    </>
  );
}

export function ContactCacheRefreshDialog({
  onClose,
  onRefresh,
  stale = false,
  fields,
}: {
  onClose: () => void;
  onRefresh?: () => void;
  stale?: boolean;
  fields?: ContactMetric[];
}) {
  const uin = useViewState((state) => state.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: Boolean(uin),
  });
  const [range, setRange] = useState<'older24h' | 'all' | 'none'>('older24h');
  useEffect(() => {
    const update = () => {
      try {
        const saved = preferenceValue('contactOrder').refreshRange;
        if (saved === 'older24h' || saved === 'all' || saved === 'none') setRange(saved);
        else setRange('older24h');
      } catch {
        /* 使用默认更新范围。 */
      }
    };
    update();
    window.addEventListener(PREFERENCES_CHANGED, update);
    return () => window.removeEventListener(PREFERENCES_CHANGED, update);
  }, []);
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
      const taskId = await rebuild.mutateAsync({
        ...binding,
        missingOnly: false,
        range,
        ...(fields?.length ? { fields } : {}),
      });
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
      showError(
        '好友/群信息缓存更新启动失败',
        error instanceof Error ? error.message : String(error),
      );
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
            更新好友/群信息缓存
          </h3>
          <button type="button" className="weq-dialog-x" aria-label="关闭" onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="weq-dialog-body">
          {stale && <p>所选依据的好友/群信息缓存已超过 7 天或尚未建立，是否更新？</p>}
          <p>选择好友/群信息缓存的更新范围。</p>
          <SegmentedControl
            label="好友/群信息缓存更新范围"
            disabled={rebuild.isLoading}
            value={range}
            options={[
              { value: 'older24h', label: '超 24h 未更新' },
              { value: 'all', label: '全部' },
              { value: 'none', label: '不更新' },
            ]}
            onChange={(value) => {
              setRange(value);
              void changePreference('contactOrder', { refreshRange: value });
            }}
          />
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
            {range === 'none' ? '仅刷新列表' : '更新'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
