import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { useTabActive } from '../RetainedTabs';
import { Row } from './controls';

export function ClearReadRecordsSetting() {
  const active = useTabActive();
  const account = trpc.account.getAccountConfig.useQuery(undefined, { enabled: active });
  const clear = trpc.account.clearLocalReadRecords.useMutation();
  const utils = trpc.useUtils();
  const dialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const scope = `${account.data?.uin ?? ''}:${account.data?.configId ?? ''}`;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  useEffect(() => {
    setStatus('');
    setError('');
  }, [scope]);

  async function erase() {
    const config = account.data;
    if (busy || !config?.uin || !config.configId) return;
    const expectedScope = scope;
    setBusy(true);
    setStatus('');
    setError('');
    try {
      if (
        !(await dialog.confirm(
          '清除 WeQ 已读记录？',
          '清除当前账号在 WeQ 保存的阅读位置和手动已读、未读标记，随后按 QQ 数据库重新显示未读状态。不会删除消息，也不会修改 QQ 数据库或其他端已确认的已读位置。',
          { okLabel: '清除', cancelLabel: '取消', tone: 'warning' },
        ))
      )
        return;
      if (latestScope.current !== expectedScope) return;
      await clear.mutateAsync({
        expectedAccountUin: config.uin,
        expectedAccountConfigId: config.configId,
      });
      await utils.account.getUnreadInfos.invalidate();
      if (latestScope.current === expectedScope) setStatus('已清除');
    } catch (reason) {
      if (latestScope.current === expectedScope)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Row
        settingId="clear-local-read-records"
        label="WeQ 已读记录"
        desc="当未读标记出现异常时使用"
        control={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-danger"
            disabled={busy || !account.data?.uin || !account.data?.configId || !!account.error}
            onClick={() => void erase()}
          >
            <Trash2 size={14} aria-hidden />
            {busy ? '正在清除…' : '清除 WeQ 已读记录'}
          </button>
        }
      />
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
