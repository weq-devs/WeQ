import { useState } from 'react';
import { trpc, client } from '../../trpc/client';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { useDialog } from '../Dialog.shared';
import { Row, Toggle, QueryError } from './controls';

export function NativeDebugLogSetting() {
  const { enabled } = useQQReadActivity(true, { onlineOnly: false });
  const state = trpc.help.getNativeDebugLog.useQuery(undefined, {
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const utils = trpc.useUtils();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async (value: boolean) => {
    if (busy) return;
    if (
      value &&
      !(await dialog.confirm(
        '开启底层调试日志？',
        '调试日志会增加记录量和磁盘占用，排查完成后请关闭。',
        { okLabel: '开启调试', tone: 'warning' },
      ))
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result = await client.help.setNativeDebugLog.mutate({ enabled: value });
      if (!result.ok) throw new Error(result.error ?? '切换调试日志失败');
      utils.help.getNativeDebugLog.setData(undefined, { enabled: result.enabled, available: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row
        settingId="native-debug-log"
        desc={
          state.data?.available === false
            ? '原生组件未就绪'
            : state.data?.enabled
              ? '已开启，应用重启后关闭。'
              : '关闭'
        }
        control={
          <Toggle
            label="原生调试日志"
            checked={state.data?.enabled ?? false}
            disabled={busy || !state.data?.available || !!state.error}
            onChange={(value) => void change(value)}
          />
        }
      />
      {state.error && (
        <QueryError
          message={state.error.message}
          retryLabel="重新读取调试状态"
          onRetry={() => void state.refetch()}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
